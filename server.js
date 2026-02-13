const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 🧀 游戏全局数据 ---
let players = [];    
let gamePhase = 'waiting'; 
let currentHour = 0; 
let cheeseHolder = null; // 【关键修复】之前这行丢了，导致报错
let votes = {};      
let gameTimer = null;    // 【关键修复】防幽灵车定时器

const ROLE_CONFIG = ['Thief', 'Critter', 'Follower', 'GoodRat', 'GoodRat', 'GoodRat'];

io.on('connection', (socket) => {
    console.log('玩家连接:', socket.id);

    // 1. 加入
    socket.on('join', (name) => {
        if(players.find(p => p.name === name)) {
            name = name + '#' + Math.floor(Math.random()*100);
        }
        players.push({
            id: socket.id,
            name: name,
            role: '?',
            dice: 0,
            isFollower: false
        });
        io.emit('updateList', players);
    });

    // 2. 开始游戏
    socket.on('startGame', () => {
        if (players.length < 2) return; 
        
        // 🛑 刹车系统
        if (gameTimer) { clearTimeout(gameTimer); gameTimer = null; }

        gamePhase = 'night';
        cheeseHolder = null; 
        votes = {};
        
        assignRolesAndDice();
        io.emit('gameStarted', players);
        
        console.log("=== 新游戏开始 ===");
        startNightPhase(1); 
    });

    // 3. 大盗选同伙
    socket.on('thiefChooseFollower', (targetId) => {
        const me = players.find(p => p.id === socket.id);
        if (!me || me.role !== 'Thief') return;

        const target = players.find(p => p.id === targetId);
        if (target) {
            target.isFollower = true;
            io.to(targetId).emit('secretMessage', { type: 'YouAreFollower', thiefName: me.name });
        }
    });

    // 4. 偷奶酪
    socket.on('stealCheese', () => {
        const me = players.find(p => p.id === socket.id);
        if (me && me.role === 'Thief' && me.dice === currentHour && cheeseHolder === null) {
            cheeseHolder = me.id; 
            console.log(`大盗 ${me.name} 偷走了奶酪！`);
            
            // 只告诉醒着的人
            const awakePlayers = players.filter(p => p.dice === currentHour);
            awakePlayers.forEach(p => {
                io.to(p.id).emit('cheeseUpdate', { hasCheese: false, thiefId: me.id });
            });
        }
    });

    // 5. 查验 & 投票 & 断开连接
    socket.on('peekPlayer', (tid) => {
        const me = players.find(p => p.id === socket.id);
        const target = players.find(p => p.id === tid);
        if (me && me.dice === currentHour && target) {
            socket.emit('peekResult', { name: target.name, dice: target.dice });
        }
    });

    socket.on('submitVote', (tid) => {
        if (gamePhase !== 'day') return;
        votes[socket.id] = tid;
        if (Object.keys(votes).length === players.length) calculateWinner();
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('updateList', players);
        if(players.length === 0 && gameTimer) { clearTimeout(gameTimer); gameTimer = null; }
    });
});

// --- 辅助函数 ---
function assignRolesAndDice() {
    let currentRoles = ROLE_CONFIG.slice(0, players.length);
    while(currentRoles.length < players.length) currentRoles.push('GoodRat');
    currentRoles.sort(() => Math.random() - 0.5);

    players.forEach((p, index) => {
        p.role = currentRoles[index];
        p.dice = Math.floor(Math.random() * 6) + 1; // 正常随机
        // p.dice = 1; // ⚠️ 测试用：强制全员1点 (测完记得注释掉)
        p.isFollower = false;
    });
}

function startNightPhase(hour) {
    currentHour = hour;

    // A. 大盗时间 (7点)
    if (hour === 7) {
        console.log("--- 7点: 大盗时间 ---");
        players.forEach(p => {
            const isThief = (p.role === 'Thief');
            io.to(p.id).emit('nightHour', { 
                hour: 7, 
                cheeseExist: isThief ? (cheeseHolder === null) : null, 
                awakeList: [] 
            });
        });
        gameTimer = setTimeout(() => startNightPhase(8), 15000); 
        return;
    }

    // B. 天亮 (8点)
    if (hour > 7) {
        console.log("--- 天亮了 ---");
        gamePhase = 'day';
        io.emit('phaseChange', { phase: 'day', playerList: players });
        return;
    }

    // C. 普通夜晚 (1-6点)
    console.log(`--- ${hour} 点 ---`);
    const awakePlayers = players.filter(p => p.dice === hour);
    const awakeIds = awakePlayers.map(p => p.id);

    players.forEach(p => {
        const isAwake = (p.dice === hour);
        if (isAwake) {
            io.to(p.id).emit('nightHour', { 
                hour: hour, 
                cheeseExist: (cheeseHolder === null), 
                awakeList: awakeIds 
            });
        } else {
            io.to(p.id).emit('nightHour', { hour: hour, cheeseExist: null, awakeList: [] });
        }
    });

    gameTimer = setTimeout(() => startNightPhase(hour + 1), 10000); 
}

function calculateWinner() {
    let voteCounts = {};
    Object.values(votes).forEach(vid => voteCounts[vid] = (voteCounts[vid]||0)+1);
    
    let maxVotes = 0;
    let victimId = null;
    for(let vid in voteCounts) {
        if(voteCounts[vid] > maxVotes) { maxVotes = voteCounts[vid]; victimId = vid; }
    }

    const victim = players.find(p => p.id === victimId);
    let result = { winner: '', message: '' };

    if(!victim) {
        result.winner = '平局';
        result.message = '没人被投出？';
    } else {
        if (victim.role === 'Critter') {
            result.winner = '呆呆鼠';
            result.message = `🐭 呆呆鼠【${victim.name}】被抓！呆呆鼠胜利！`;
        } else if (victim.role === 'Thief') {
            result.winner = '好鼠';
            result.message = `🚓 大盗【${victim.name}】被抓！好人胜利！`;
        } else {
            result.winner = '大盗 & 同伙';
            result.message = `😱 冤枉啊！【${victim.name}】是好人！大盗胜利！`;
        }
    }
    io.emit('gameOver', result);
    gamePhase = 'waiting'; 
    if (gameTimer) clearTimeout(gameTimer);
}

server.listen(3000, () => {
    console.log('🧀 服务器已修复 (防作弊+防幽灵车+奶酪变量修复)');
});