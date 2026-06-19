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

// sessions: token -> accountId
const sessions = new Map();

app.use(express.json());
app.use(express.static(publicDir));
app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

// ─── 账号系统工具函数 ───────────────────────────────────────────────────────────

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
        return JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts || [];
    } catch (_err) {
        return [];
    }
}

function saveAccounts(accounts) {
    ensureDataDir();
    fs.writeFileSync(accountsFile, JSON.stringify({ accounts }, null, 2), 'utf8');
}

function hashPassword(password, salt) {
    return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

function normalizeUsername(raw) {
    return String(raw || '').trim().toLowerCase();
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getAccountFromToken(token) {
    if (!token) return null;
    const accountId = sessions.get(token);
    if (!accountId) return null;
    const accounts = loadAccounts();
    return accounts.find((a) => a.id === accountId) || null;
}

// ─── API 路由 ──────────────────────────────────────────────────────────────────

app.post('/api/register', (req, res) => {
    const username = normalizeUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || '');

    if (!username || password.length < 4) {
        return res.status(400).json({ message: '账号名不能为空，密码至少 4 位。' });
    }

    const accounts = loadAccounts();
    if (accounts.some((a) => a.username === username)) {
        return res.status(409).json({ message: '这个账号名已经被注册。' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const newAccount = {
        id: crypto.randomUUID(),
        username,
        salt,
        passwordHash: hashPassword(password, salt),
        coins: 0,
        avatar: null,
        createdAt: new Date().toISOString(),
    };

    accounts.push(newAccount);
    saveAccounts(accounts);

    const token = generateToken();
    sessions.set(token, newAccount.id);

    return res.json({ token, account: publicAccount(newAccount) });
});

app.post('/api/login', (req, res) => {
    const username = normalizeUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || '');

    const accounts = loadAccounts();
    const account = accounts.find((a) => a.username === username);
    if (!account) {
        return res.status(401).json({ message: '账号不存在。' });
    }

    if (hashPassword(password, account.salt) !== account.passwordHash) {
        return res.status(401).json({ message: '密码不正确。' });
    }

    const token = generateToken();
    sessions.set(token, account.id);

    return res.json({ token, account: publicAccount(account) });
});

app.get('/api/me', (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const account = getAccountFromToken(token);
    if (!account) {
        return res.status(401).json({ message: '登录已失效，请重新登录。' });
    }
    return res.json({ account: publicAccount(account) });
});

app.post('/api/me/avatar', (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const account = getAccountFromToken(token);
    if (!account) {
        return res.status(401).json({ message: '登录已失效，请重新登录。' });
    }

    const avatar = String((req.body && req.body.avatar) || '').trim();
    if (!avatar) {
        return res.status(400).json({ message: '头像不能为空。' });
    }

    const accounts = loadAccounts();
    const idx = accounts.findIndex((a) => a.id === account.id);
    if (idx === -1) {
        return res.status(404).json({ message: '账号不存在。' });
    }

    accounts[idx].avatar = avatar;
    saveAccounts(accounts);

    return res.json({ account: publicAccount(accounts[idx]) });
});

function publicAccount(account) {
    return {
        id: account.id,
        username: account.username,
        coins: account.coins || 0,
        avatar: account.avatar || null,
    };
}

// ─── 游戏逻辑 ──────────────────────────────────────────────────────────────────

const MIN_PLAYERS = 3;

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

io.on('connection', (socket) => {
    console.log('玩家连接:', socket.id);

    socket.on('join', (payload) => {
        const token = payload && payload.authToken ? String(payload.authToken) : null;
        const rolePreference = payload && payload.rolePreference ? String(payload.rolePreference) : 'any';

        const account = getAccountFromToken(token);
        if (!account) {
            socket.emit('joinRejected', { message: '请先登录账号再加入游戏。' });
            return;
        }

        if (gamePhase !== 'waiting') {
            socket.emit('joinRejected', { message: '本局游戏已经开始，请等待下一局再加入。' });
            return;
        }

        if (players.some((p) => p.id === socket.id)) {
            return;
        }

        let name = account.username;
        let suffix = 1;
        while (players.some((p) => p.name === name)) {
            name = `${account.username}#${suffix++}`;
        }

        players.push(createFreshPlayer(socket.id, name, account.avatar, account.id, rolePreference));
        emitLobbyList();
    });

    socket.on('updateRolePreference', (preference) => {
        const player = findPlayer(socket.id);
        if (!player) return;
        player.rolePreference = String(preference || 'any');
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

        players
            .filter((p) => p.dice === currentHour)
            .forEach((p) => {
                io.to(p.id).emit('cheeseUpdate', {
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

        io.emit(
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
        if (gamePhase !== 'day' || !voter || !target) {
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
        players = players.filter((p) => p.id !== socket.id);

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

// ─── 玩家工厂 ──────────────────────────────────────────────────────────────────

function createFreshPlayer(id, name, avatar, accountId, rolePreference) {
    return {
        id,
        name,
        avatar: avatar || null,
        accountId: accountId || null,
        rolePreference: rolePreference || 'any',
        role: '?',
        dice: 0,
        isFollower: false,
        hasPeeked: false,
    };
}

// ─── 游戏工具函数 ──────────────────────────────────────────────────────────────

function emitLobbyList() {
    io.emit('updateList', {
        players: getPublicPlayers(),
        gamePhase,
        minPlayers: MIN_PLAYERS,
    });
}

function getPublicPlayers() {
    return players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
    }));
}

function findPlayer(id) {
    return players.find((p) => p.id === id);
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

    players.forEach((p) => {
        p.role = '?';
        p.dice = 0;
        p.isFollower = false;
        p.hasPeeked = false;
    });
}

function assignRolesAndDice() {
    const n = players.length;
    const roles = ['Thief', 'Critter'];
    while (roles.length < n) roles.push('GoodRat');

    // 先按偏好分桶，再随机抽
    const wantThief = players.filter((p) => p.rolePreference === 'Thief');
    const wantCritter = players.filter((p) => p.rolePreference === 'Critter');
    const wantGood = players.filter((p) => p.rolePreference === 'GoodRat');
    const wantAny = players.filter((p) => p.rolePreference === 'any');

    roles.sort(() => Math.random() - 0.5);

    const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);
    const remaining = shuffle([...players]);

    players.forEach((p) => {
        p.role = '?';
        p.dice = Math.floor(Math.random() * 6) + 1;
        p.isFollower = false;
        p.hasPeeked = false;
    });

    // 简单概率提升：偏好者优先排入对应角色
    const assigned = new Set();
    const rolePool = [...roles];

    function tryAssign(pref, roleName) {
        const idx = rolePool.indexOf(roleName);
        if (idx === -1) return;
        const candidates = players.filter((p) => p.rolePreference === pref && !assigned.has(p.id));
        if (candidates.length === 0) return;
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        chosen.role = roleName;
        assigned.add(chosen.id);
        rolePool.splice(idx, 1);
    }

    tryAssign('Thief', 'Thief');
    tryAssign('Critter', 'Critter');

    // 剩余玩家随机分配剩余角色
    const unassigned = players.filter((p) => !assigned.has(p.id));
    shuffle(unassigned);
    unassigned.forEach((p, i) => {
        p.role = rolePool[i] || 'GoodRat';
    });
}

function sendPrivateIdentities() {
    players.forEach((p) => {
        io.to(p.id).emit('identityUpdate', {
            role: p.role,
            dice: p.dice,
            isFollower: p.isFollower,
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
    const awakePlayers = players.filter((p) => p.dice === hour);
    currentAwakeIds = awakePlayers.map((p) => p.id);
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

    players.forEach((p) => {
        const isAwake = currentAwakeIds.includes(p.id);
        const canPeek =
            isAwake &&
            currentAwakeIds.length === 1 &&
            ['GoodRat', 'Critter'].includes(p.role) &&
            !p.hasPeeked;
        const canSteal = isAwake && p.role === 'Thief' && cheeseHolder === null;
        io.to(p.id).emit('nightHour', {
            hour,
            isAwake,
            awakeNames: awakePlayers
                .filter((ap) => ap.id !== p.id)
                .map((ap) => ap.name),
            cheeseAvailable: isAwake ? cheeseHolder === null : null,
            canSteal,
            canPeek,
            canComplete: isAwake && !isNightActionStillRequired(p, canPeek),
            completionRequired: isAwake,
            sleepingMessage: `${hour} 点进行中，请保持闭眼。`,
        });
    });
}

function startChooseFollowerPhase() {
    clearGameTimer();
    gamePhase = 'chooseFollower';

    const thief = players.find((p) => p.role === 'Thief');
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
            cheeseHolder === null
    );
}

function canPeekAtPlayer(player, target) {
    if (!player || !target || player.id === target.id || gamePhase !== 'night') return false;
    if (!['GoodRat', 'Critter'].includes(player.role)) return false;
    if (player.hasPeeked) return false;
    if (player.dice !== currentHour) return false;
    const awake = players.filter((p) => p.dice === currentHour);
    return awake.length === 1 && awake[0].id === player.id;
}

function canCompleteNightTurn(player) {
    if (!player || gamePhase !== 'night' || !currentAwakeIds.includes(player.id)) return false;
    if (completedNightIds.has(player.id)) return false;
    return !isNightActionStillRequired(player);
}

function isNightActionStillRequired(player, canPeekOverride) {
    if (!player || !currentAwakeIds.includes(player.id)) return false;

    if (player.role === 'Thief' && player.dice === currentHour && cheeseHolder === null) return true;

    const canPeek =
        typeof canPeekOverride === 'boolean'
            ? canPeekOverride
            : currentAwakeIds.length === 1 &&
              ['GoodRat', 'Critter'].includes(player.role) &&
              player.dice === currentHour &&
              !player.hasPeeked;

    return canPeek;
}

function advanceNightFlow() {
    io.emit('systemMessage', '');
    startNightHour(currentHour + 1);
}

function calculateWinner() {
    const voteCounts = {};
    Object.values(votes).forEach((targetId) => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    const sorted = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    const second = sorted[1];

    let result;
    if (!top || (second && second[1] === top[1])) {
        result = { winner: '平局', message: '平票，无人出局。' };
    } else {
        const victim = findPlayer(top[0]);
        result = buildWinnerResult(victim);
        if (result.winner !== '平局') {
            awardCoins(result.winner, victim);
        }
    }

    io.emit('gameOver', {
        ...result,
        reveals: players.map((p) => ({
            name: p.name,
            avatar: p.avatar,
            role: p.role,
            isFollower: p.isFollower,
            dice: p.dice,
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
            message: `奶酪大盗【${victim.name}】被投出，好鼠胜利。`,
        };
    }

    const hasFollower = players.some((p) => p.isFollower);
    return {
        winner: hasFollower ? '奶酪大盗和同伙' : '奶酪大盗',
        message: `【${victim.name}】被投出，奶酪大盗${hasFollower ? '和同伙' : ''}胜利。`,
    };
}

function awardCoins(winner, victim) {
    const accounts = loadAccounts();
    let changed = false;

    function addCoin(accountId, amount) {
        const idx = accounts.findIndex((a) => a.id === accountId);
        if (idx !== -1) {
            accounts[idx].coins = (accounts[idx].coins || 0) + amount;
            changed = true;
        }
    }

    if (winner === '好鼠') {
        players.filter((p) => p.role === 'GoodRat' && !p.isFollower && p.accountId).forEach((p) => addCoin(p.accountId, 1));
        const critter = players.find((p) => p.role === 'Critter' && !p.isFollower);
        if (critter && critter.accountId) addCoin(critter.accountId, 1);
    } else if (winner === '呆呆鼠') {
        if (victim && victim.accountId) addCoin(victim.accountId, 2);
    } else if (winner === '奶酪大盗' || winner === '奶酪大盗和同伙') {
        const thief = players.find((p) => p.role === 'Thief');
        if (thief && thief.accountId) addCoin(thief.accountId, 1);
        if (winner === '奶酪大盗和同伙') {
            players.filter((p) => p.isFollower && p.accountId).forEach((p) => addCoin(p.accountId, 1));
        }
    } else if (winner === '大盗和呆呆鼠') {
        const thief = players.find((p) => p.role === 'Thief');
        if (thief && thief.accountId) addCoin(thief.accountId, 1);
        if (victim && victim.accountId) addCoin(victim.accountId, 1);
    }

    if (changed) saveAccounts(accounts);
}

function abortCurrentGame(message) {
    clearGameTimer();
    resetRoundState();
    gamePhase = 'waiting';
    io.emit('gameAborted', { message });
    emitLobbyList();
}

// ─── 启动服务器 ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`奶酪大盗服务器运行在 http://0.0.0.0:${PORT}`);
});
