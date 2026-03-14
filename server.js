const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

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

    socket.on('join', (rawName) => {
        const trimmedName = String(rawName || '').trim();
        if (!trimmedName) {
            return;
        }

        if (players.some((player) => player.id === socket.id)) {
            return;
        }

        let name = trimmedName;
        while (players.some((player) => player.name === name)) {
            name = `${trimmedName}#${Math.floor(Math.random() * 100)}`;
        }

        players.push(createFreshPlayer(socket.id, name));
        emitLobbyList();
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
            .filter((player) => player.dice === currentHour)
            .forEach((player) => {
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

function createFreshPlayer(id, name) {
    return {
        id,
        name,
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
    const roles = ['Thief', 'Critter'];

    while (roles.length < players.length) {
        roles.push('GoodRat');
    }

    roles.sort(() => Math.random() - 0.5);

    players.forEach((player, index) => {
        player.role = roles[index];
        player.dice = Math.floor(Math.random() * 6) + 1;
        player.isFollower = false;
        player.hasPeeked = false;
    });
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
            cheeseHolder === null
    );
}

function canPeekAtPlayer(player, target) {
    if (!player || !target || player.id === target.id || gamePhase !== 'night') {
        return false;
    }

    if (!['GoodRat', 'Critter'].includes(player.role)) {
        return false;
    }

    if (player.hasPeeked) {
        return false;
    }

    if (player.dice !== currentHour) {
        return false;
    }

    const awakePlayers = players.filter((awakePlayer) => awakePlayer.dice === currentHour);
    return awakePlayers.length === 1 && awakePlayers[0].id === player.id;
}

function canCompleteNightTurn(player) {
    if (!player || gamePhase !== 'night' || !currentAwakeIds.includes(player.id)) {
        return false;
    }

    if (completedNightIds.has(player.id)) {
        return false;
    }

    return !isNightActionStillRequired(player);
}

function isNightActionStillRequired(player, canPeekOverride) {
    if (!player || !currentAwakeIds.includes(player.id)) {
        return false;
    }

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

function advanceNightFlow() {
    io.emit('systemMessage', '');
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

    if (!topVote || (secondVote && secondVote[1] === topVote[1])) {
        result = {
            winner: '平局',
            message: '平票，无人出局。',
        };
    } else {
        const victim = findPlayer(topVote[0]);
        result = buildWinnerResult(victim);
    }

    io.emit('gameOver', {
        ...result,
        reveals: players.map((player) => ({
            name: player.name,
            role: player.role,
            isFollower: player.isFollower,
            dice: player.dice,
        })),
    });

    clearGameTimer();
    gamePhase = 'waiting';
    resetRoundState();
    emitLobbyList();
}

function buildWinnerResult(victim) {
    if (!victim) {
        return {
            winner: '平局',
            message: '没有有效票型，本局平局。',
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

    const hasFollower = players.some((player) => player.isFollower);
    return {
        winner: hasFollower ? '奶酪大盗和同伙' : '奶酪大盗',
        message: `【${victim.name}】被投出，奶酪大盗${hasFollower ? '和同伙' : ''}胜利。`,
    };
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