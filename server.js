const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const accountsFile = path.join(dataDir, 'accounts.json');

const MIN_PLAYERS = 3;
const ACCOUNT_AVATARS = [
    '卡通老鼠图1.png',
    '卡通老鼠图2.png',
    '卡通老鼠图3.png',
    '卡通老鼠图4.jpg',
    '卡通老鼠图5.jpg',
    '卡通老鼠图6.jpg',
    '卡通老鼠图7.png',
    '卡通老鼠图8.png',
];

const VALID_ROLE_PREFERENCES = new Set(['any', 'Thief', 'Critter', 'GoodRat']);

// token -> accountId. Tokens are intentionally in-memory; account data is persistent.
const sessions = new Map();

let players = [];
let gamePhase = 'waiting';
let currentHour = 0;
let cheeseHolder = null;
let votes = {};
let gameTimer = null;
let followerChosen = false;
let identityConfirmedIds = new Set();
let currentAwakeIds = [];
let completedNightIds = new Set();

app.use(express.json());
app.use(express.static(publicDir));

app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.post('/api/register', (req, res) => {
    const username = normalizeUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || '');

    if (!username || username.length > 20) {
        return res.status(400).json({ message: '账号名不能为空，且最多 20 个字。' });
    }

    if (password.length < 4) {
        return res.status(400).json({ message: '密码至少 4 位。' });
    }

    const accounts = loadAccounts();
    if (accounts.some((account) => account.username === username)) {
        return res.status(409).json({ message: '这个账号名已经被注册。' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const newAccount = {
        id: crypto.randomUUID(),
        username,
        salt,
        passwordHash: hashPassword(password, salt),
        coins: 0,
        avatar: getRandomAvatar(),
        createdAt: new Date().toISOString(),
    };

    accounts.push(newAccount);
    saveAccounts(accounts);

    const token = generateToken();
    sessions.set(token, newAccount.id);

    res.json({ token, account: getSafeAccount(newAccount) });
});

app.post('/api/login', (req, res) => {
    const username = normalizeUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || '');

    const accounts = loadAccounts();
    const account = accounts.find((item) => item.username === username);
    if (!account || !verifyPassword(password, account)) {
        return res.status(401).json({ message: '账号或密码不正确。' });
    }

    const token = generateToken();
    sessions.set(token, account.id);

    res.json({ token, account: getSafeAccount(account) });
});

app.get('/api/me', (req, res) => {
    const account = getAccountFromRequest(req);
    if (!account) {
        return res.status(401).json({ message: '登录已失效，请重新登录。' });
    }

    res.json({ account: getSafeAccount(account) });
});

app.post('/api/me/avatar', (req, res) => {
    const account = getAccountFromRequest(req);
    if (!account) {
        return res.status(401).json({ message: '登录已失效，请重新登录。' });
    }

    const avatar = String((req.body && req.body.avatar) || '').trim();
    if (!ACCOUNT_AVATARS.includes(avatar)) {
        return res.status(400).json({ message: '请选择有效头像。' });
    }

    const accounts = loadAccounts();
    const storedAccount = accounts.find((item) => item.id === account.id);
    if (!storedAccount) {
        return res.status(404).json({ message: '账号不存在。' });
    }

    storedAccount.avatar = avatar;
    saveAccounts(accounts);

    const player = players.find((item) => item.accountId === storedAccount.id);
    if (player) {
        player.avatar = avatar;
        emitLobbyList();
    }

    res.json({ account: getSafeAccount(storedAccount) });
});

io.on('connection', (socket) => {
    console.log('玩家连接:', socket.id);

    socket.on('join', (payload) => {
        const token = payload && payload.authToken ? String(payload.authToken) : '';
        const rolePreference = normalizeRolePreference(payload && payload.rolePreference);
        const account = getAccountFromToken(token);

        if (!account) {
            socket.emit('joinRejected', { message: '请先登录账号再加入游戏。' });
            return;
        }

        if (gamePhase !== 'waiting') {
            socket.emit('joinRejected', { message: '本局游戏已经开始，请等待下一局再加入。' });
            return;
        }

        if (players.some((player) => player.accountId === account.id && player.id !== socket.id)) {
            socket.emit('joinRejected', { message: '这个账号已经在房间里了。' });
            return;
        }

        const existingPlayer = findPlayer(socket.id);
        if (existingPlayer) {
            existingPlayer.rolePreference = rolePreference;
            existingPlayer.avatar = account.avatar;
            emitLobbyList();
            return;
        }

        players.push(createFreshPlayer(socket.id, account.username, account.avatar, account.id, rolePreference));
        emitLobbyList();
    });

    socket.on('updateRolePreference', (preference) => {
        const player = findPlayer(socket.id);
        if (!player || gamePhase !== 'waiting') return;

        player.rolePreference = normalizeRolePreference(preference);
        socket.emit('rolePreferenceUpdated', { rolePreference: player.rolePreference });
    });

    socket.on('startGame', () => {
        if (gamePhase !== 'waiting' || players.length < MIN_PLAYERS) {
            return;
        }

        clearGameTimer();
        resetRoundState();
        assignRolesAndDice();
        gamePhase = 'identity';
        identityConfirmedIds = new Set();

        io.emit('gameStarted', {
            players: getPublicPlayers(),
            minPlayers: MIN_PLAYERS,
        });
        sendPrivateIdentities();

        console.log('=== 新游戏开始 ===');
    });

    socket.on('confirmIdentity', () => {
        if (gamePhase !== 'identity' || !findPlayer(socket.id)) {
            return;
        }

        identityConfirmedIds.add(socket.id);
        io.emit('systemMessage', `身份确认进度：${identityConfirmedIds.size}/${players.length}`);

        if (identityConfirmedIds.size === players.length) {
            io.emit('systemMessage', '所有玩家已确认身份，开始进入夜晚。');
            startNightHour(1);
        }
    });

    socket.on('stealCheese', () => {
        const me = findPlayer(socket.id);
        if (!canStealCheese(me)) {
            return;
        }

        cheeseHolder = me.id;
        console.log(`大盗 ${me.name} 偷走了奶酪`);

        getCurrentAwakePlayers().forEach((player) => {
            io.to(player.id).emit('cheeseUpdate', {
                cheeseAvailable: false,
                thiefName: me.name,
                thiefId: me.id,
            });
        });
    });

    socket.on('peekPlayer', (targetId) => {
        const me = findPlayer(socket.id);
        const target = findPlayer(targetId);
        if (!canPeekAtPlayer(me, target)) {
            return;
        }

        me.hasPeeked = true;
        socket.emit('peekResult', {
            name: target.name,
            dice: target.dice,
        });
    });

    socket.on('completeNightTurn', () => {
        const me = findPlayer(socket.id);
        if (!canCompleteNightTurn(me)) {
            return;
        }

        completedNightIds.add(me.id);
        socket.emit('nightTurnCompleted');

        if (completedNightIds.size === currentAwakeIds.length) {
            advanceNightFlow();
            return;
        }

        emitToCurrentAwakePlayers(
            'systemMessage',
            `本轮夜晚进度：${completedNightIds.size}/${currentAwakeIds.length} 位醒着玩家已完成`
        );
    });

    socket.on('thiefChooseFollower', (targetId) => {
        const me = findPlayer(socket.id);
        const target = findPlayer(targetId);
        if (
            gamePhase !== 'chooseFollower' ||
            !me ||
            me.role !== 'Thief' ||
            !target ||
            target.id === me.id ||
            followerChosen
        ) {
            return;
        }

        target.isFollower = true;
        followerChosen = true;
        clearGameTimer();

        io.to(target.id).emit('secretMessage', {
            type: 'YouAreFollower',
            thiefName: me.name,
        });
        io.to(target.id).emit('identityUpdate', {
            role: target.role,
            dice: target.dice,
            isFollower: true,
        });

        io.emit('systemMessage', `${me.name} 已经选定了同伙，马上天亮。`);
        startDayPhase();
    });

    socket.on('submitVote', (targetId) => {
        const voter = findPlayer(socket.id);
        const target = findPlayer(targetId);
        if (gamePhase !== 'day' || !voter || !target || votes[socket.id]) {
            return;
        }

        votes[socket.id] = targetId;
        socket.emit('voteConfirmed', { targetId });

        if (Object.keys(votes).length === players.length) {
            calculateWinner();
        }
    });

    socket.on('disconnect', () => {
        const leavingPlayer = findPlayer(socket.id);
        players = players.filter((player) => player.id !== socket.id);

        if (players.length === 0) {
            clearGameTimer();
            resetRoundState();
            gamePhase = 'waiting';
            return;
        }

        if (leavingPlayer && gamePhase !== 'waiting') {
            abortCurrentGame(`${leavingPlayer.name} 断线离开，本局已取消。`);
            return;
        }

        emitLobbyList();
    });
});

function ensureDataDir() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function loadAccounts() {
    ensureDataDir();
    if (!fs.existsSync(accountsFile)) {
        return [];
    }

    try {
        const payload = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
        let changed = false;

        accounts.forEach((account) => {
            if (typeof account.coins !== 'number') {
                account.coins = 0;
                changed = true;
            }

            if (!ACCOUNT_AVATARS.includes(account.avatar)) {
                account.avatar = ACCOUNT_AVATARS[3];
                changed = true;
            }
        });

        if (changed) {
            saveAccounts(accounts);
        }

        return accounts;
    } catch (error) {
        console.error('读取账号数据失败:', error);
        return [];
    }
}

function saveAccounts(accounts) {
    ensureDataDir();
    fs.writeFileSync(accountsFile, JSON.stringify({ accounts }, null, 2), 'utf8');
}

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 32).toString('hex');
}

function legacyHashPassword(password, salt) {
    return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

function verifyPassword(password, account) {
    const currentHash = hashPassword(password, account.salt);
    if (currentHash === account.passwordHash) {
        return true;
    }

    // Keeps older local accounts usable if they were created by the temporary HMAC version.
    if (legacyHashPassword(password, account.salt) === account.passwordHash) {
        account.passwordHash = currentHash;
        const accounts = loadAccounts();
        const storedAccount = accounts.find((item) => item.id === account.id);
        if (storedAccount) {
            storedAccount.passwordHash = currentHash;
            saveAccounts(accounts);
        }
        return true;
    }

    return false;
}

function normalizeUsername(raw) {
    return String(raw || '').trim().toLowerCase();
}

function normalizeRolePreference(raw) {
    const preference = String(raw || 'any');
    return VALID_ROLE_PREFERENCES.has(preference) ? preference : 'any';
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getAuthToken(req) {
    return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

function getAccountFromRequest(req) {
    return getAccountFromToken(getAuthToken(req));
}

function getAccountFromToken(token) {
    if (!token) return null;
    const accountId = sessions.get(token);
    if (!accountId) return null;

    const accounts = loadAccounts();
    return accounts.find((account) => account.id === accountId) || null;
}

function getSafeAccount(account) {
    return {
        id: account.id,
        username: account.username,
        coins: account.coins || 0,
        avatar: ACCOUNT_AVATARS.includes(account.avatar) ? account.avatar : ACCOUNT_AVATARS[3],
    };
}

function getRandomAvatar() {
    return ACCOUNT_AVATARS[Math.floor(Math.random() * ACCOUNT_AVATARS.length)];
}

function createFreshPlayer(id, name, avatar, accountId, rolePreference) {
    return {
        id,
        name,
        avatar: ACCOUNT_AVATARS.includes(avatar) ? avatar : ACCOUNT_AVATARS[3],
        accountId,
        rolePreference: normalizeRolePreference(rolePreference),
        role: '?',
        dice: 0,
        isFollower: false,
        hasPeeked: false,
    };
}

function emitLobbyList() {
    io.emit('updateList', {
        players: getPublicPlayers(),
        gamePhase,
        minPlayers: MIN_PLAYERS,
    });
}

function getPublicPlayers() {
    return players.map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
    }));
}

function findPlayer(id) {
    return players.find((player) => player.id === id);
}

function clearGameTimer() {
    if (gameTimer) {
        clearTimeout(gameTimer);
        gameTimer = null;
    }
}

function resetRoundState() {
    currentHour = 0;
    cheeseHolder = null;
    votes = {};
    followerChosen = false;
    identityConfirmedIds = new Set();
    currentAwakeIds = [];
    completedNightIds = new Set();

    players.forEach((player) => {
        player.role = '?';
        player.dice = 0;
        player.isFollower = false;
        player.hasPeeked = false;
    });
}

function assignRolesAndDice() {
    players.forEach((player) => {
        player.role = '?';
        player.dice = Math.floor(Math.random() * 6) + 1;
        player.isFollower = false;
        player.hasPeeked = false;
    });

    const assignedIds = new Set();
    assignSingleRoleWithPreference('Thief', assignedIds);
    assignSingleRoleWithPreference('Critter', assignedIds);

    players.forEach((player) => {
        if (!assignedIds.has(player.id)) {
            player.role = 'GoodRat';
        }
    });
}

function assignSingleRoleWithPreference(role, assignedIds) {
    const candidates = players.filter((player) => !assignedIds.has(player.id));
    const chosen = pickWeighted(candidates, (player) => getRolePreferenceWeight(player, role));
    if (!chosen) return;

    chosen.role = role;
    assignedIds.add(chosen.id);
}

function getRolePreferenceWeight(player, role) {
    if (player.rolePreference === role) {
        return 3;
    }

    if (player.rolePreference === 'GoodRat' && role !== 'GoodRat') {
        return 0.5;
    }

    return 1;
}

function pickWeighted(items, getWeight) {
    const total = items.reduce((sum, item) => sum + getWeight(item), 0);
    if (total <= 0) return items[0] || null;

    let roll = Math.random() * total;
    for (const item of items) {
        roll -= getWeight(item);
        if (roll <= 0) {
            return item;
        }
    }

    return items[items.length - 1] || null;
}

function sendPrivateIdentities() {
    players.forEach((player) => {
        io.to(player.id).emit('identityUpdate', {
            role: player.role,
            dice: player.dice,
            isFollower: player.isFollower,
        });
    });
}

function startNightHour(hour) {
    gamePhase = 'night';
    currentHour = hour;

    if (hour > 6) {
        startChooseFollowerPhase();
        return;
    }

    console.log(`--- ${hour} 点 ---`);
    const awakePlayers = players.filter((player) => player.dice === hour);
    currentAwakeIds = awakePlayers.map((player) => player.id);
    completedNightIds = new Set();

    if (currentAwakeIds.length === 0) {
        io.emit('nightHour', {
            hour,
            isAwake: false,
            awakeNames: [],
            cheeseAvailable: null,
            canSteal: false,
            canPeek: false,
            canComplete: false,
            completionRequired: false,
            sleepingMessage: `${hour} 点无人醒来，自动进入下一时刻。`,
        });
        advanceNightFlow();
        return;
    }

    players.forEach((player) => {
        const isAwake = currentAwakeIds.includes(player.id);
        const canPeek =
            isAwake &&
            currentAwakeIds.length === 1 &&
            ['GoodRat', 'Critter'].includes(player.role) &&
            !player.hasPeeked;
        const canSteal = isAwake && player.role === 'Thief' && cheeseHolder === null;

        io.to(player.id).emit('nightHour', {
            hour,
            isAwake,
            awakeNames: awakePlayers
                .filter((awakePlayer) => awakePlayer.id !== player.id)
                .map((awakePlayer) => awakePlayer.name),
            cheeseAvailable: isAwake ? cheeseHolder === null : null,
            canSteal,
            canPeek,
            canComplete: isAwake && !isNightActionStillRequired(player, canPeek),
            completionRequired: isAwake,
            sleepingMessage: `${hour} 点进行中，请保持闭眼。`,
        });
    });
}

function startChooseFollowerPhase() {
    clearGameTimer();
    gamePhase = 'chooseFollower';

    const thief = players.find((player) => player.role === 'Thief');
    if (!thief || players.length < 2) {
        startDayPhase();
        return;
    }

    io.emit('chooseFollowerPhase', {
        chooserId: thief.id,
        players: getPublicPlayers(),
        cheeseAvailable: cheeseHolder === null,
    });
}

function startDayPhase() {
    clearGameTimer();
    gamePhase = 'day';

    io.emit('dayStarted', {
        players: getPublicPlayers(),
    });
}

function canStealCheese(player) {
    return Boolean(
        player &&
            gamePhase === 'night' &&
            player.role === 'Thief' &&
            player.dice === currentHour &&
            currentAwakeIds.includes(player.id) &&
            cheeseHolder === null
    );
}

function canPeekAtPlayer(player, target) {
    if (!player || !target || player.id === target.id || gamePhase !== 'night') return false;
    if (!['GoodRat', 'Critter'].includes(player.role)) return false;
    if (player.hasPeeked) return false;
    if (player.dice !== currentHour || !currentAwakeIds.includes(player.id)) return false;

    return currentAwakeIds.length === 1 && currentAwakeIds[0] === player.id;
}

function canCompleteNightTurn(player) {
    if (!player || gamePhase !== 'night' || !currentAwakeIds.includes(player.id)) return false;
    if (completedNightIds.has(player.id)) return false;
    return !isNightActionStillRequired(player);
}

function isNightActionStillRequired(player, canPeekOverride) {
    if (!player || !currentAwakeIds.includes(player.id)) return false;

    if (player.role === 'Thief' && player.dice === currentHour && cheeseHolder === null) {
        return true;
    }

    const canPeek =
        typeof canPeekOverride === 'boolean'
            ? canPeekOverride
            : currentAwakeIds.length === 1 &&
              ['GoodRat', 'Critter'].includes(player.role) &&
              player.dice === currentHour &&
              !player.hasPeeked;

    return canPeek;
}

function getCurrentAwakePlayers() {
    return players.filter((player) => currentAwakeIds.includes(player.id));
}

function emitToCurrentAwakePlayers(eventName, payload) {
    getCurrentAwakePlayers().forEach((player) => {
        io.to(player.id).emit(eventName, payload);
    });
}

function advanceNightFlow() {
    emitToCurrentAwakePlayers('systemMessage', '');
    startNightHour(currentHour + 1);
}

function calculateWinner() {
    const voteCounts = {};
    Object.values(votes).forEach((targetId) => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    const sortedVotes = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
    const topVote = sortedVotes[0];
    const secondVote = sortedVotes[1];

    let result;
    let victim = null;
    if (!topVote || (secondVote && secondVote[1] === topVote[1])) {
        result = { winner: '平局', message: '平票，无人出局，本局平局。' };
    } else {
        victim = findPlayer(topVote[0]);
        result = buildWinnerResult(victim);
    }

    const coinSummary = awardCoins(result.winner, victim);
    const coinByAccountId = new Map(coinSummary.map((row) => [row.accountId, row.total]));

    io.emit('gameOver', {
        ...result,
        coinSummary: coinSummary.map(({ accountId, ...row }) => row),
        reveals: players.map((player) => ({
            name: player.name,
            avatar: player.avatar,
            role: player.role,
            isFollower: player.isFollower,
            dice: player.dice,
            coins: coinByAccountId.get(player.accountId) || getStoredCoins(player.accountId),
        })),
    });

    clearGameTimer();
    gamePhase = 'waiting';
    resetRoundState();
    emitLobbyList();
}

function buildWinnerResult(victim) {
    if (!victim) {
        return { winner: '平局', message: '没有有效票型，本局平局。' };
    }

    if (victim.role === 'Critter' && victim.isFollower) {
        return {
            winner: '大盗和呆呆鼠',
            message: `同伙呆呆鼠【${victim.name}】被投出，大盗和呆呆鼠共赢。`,
        };
    }

    if (victim.role === 'Critter') {
        return {
            winner: '呆呆鼠',
            message: `呆呆鼠【${victim.name}】被投出，呆呆鼠胜利。`,
        };
    }

    if (victim.role === 'Thief') {
        return {
            winner: '好鼠',
            message: `奶酪大盗【${victim.name}】被投出，好鼠阵营胜利。`,
        };
    }

    const hasFollower = players.some((player) => player.isFollower);
    return {
        winner: hasFollower ? '奶酪大盗和同伙' : '奶酪大盗',
        message: `【${victim.name}】被投出，奶酪大盗${hasFollower ? '和同伙' : ''}胜利。`,
    };
}

function awardCoins(winner, victim) {
    const accounts = loadAccounts();
    const earnedByAccountId = new Map();

    function addCoin(player, amount) {
        if (!player || !player.accountId || amount <= 0) return;
        earnedByAccountId.set(player.accountId, (earnedByAccountId.get(player.accountId) || 0) + amount);
    }

    if (winner === '好鼠') {
        players
            .filter((player) => player.role === 'GoodRat' && !player.isFollower)
            .forEach((player) => addCoin(player, 1));
    } else if (winner === '呆呆鼠') {
        addCoin(victim, 2);
    } else if (winner === '奶酪大盗' || winner === '奶酪大盗和同伙') {
        addCoin(players.find((player) => player.role === 'Thief'), 1);
        players.filter((player) => player.isFollower).forEach((player) => addCoin(player, 1));
    } else if (winner === '大盗和呆呆鼠') {
        addCoin(players.find((player) => player.role === 'Thief'), 1);
        addCoin(victim, 1);
    }

    let changed = false;
    accounts.forEach((account) => {
        const earned = earnedByAccountId.get(account.id) || 0;
        if (earned > 0) {
            account.coins = (account.coins || 0) + earned;
            changed = true;
        }
    });

    if (changed) {
        saveAccounts(accounts);
    }

    const accountById = new Map(accounts.map((account) => [account.id, account]));
    return players.map((player) => {
        const account = accountById.get(player.accountId);
        return {
            accountId: player.accountId,
            name: player.name,
            earned: earnedByAccountId.get(player.accountId) || 0,
            total: account ? account.coins || 0 : 0,
        };
    });
}

function getStoredCoins(accountId) {
    const account = loadAccounts().find((item) => item.id === accountId);
    return account ? account.coins || 0 : 0;
}

function abortCurrentGame(message) {
    clearGameTimer();
    resetRoundState();
    gamePhase = 'waiting';
    io.emit('gameAborted', { message });
    emitLobbyList();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`奶酪大盗服务器运行在 http://0.0.0.0:${PORT}`);
});
