const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 🧀 游戏核心数据 ---
let players = [];    // 玩家列表
let gamePhase = 'waiting'; // waiting, night, day
let currentHour = 0; // 当前是几点 (1-6)
let thiefId = null;  // 记录大盗是谁，方便后台查找

// 身份配置 (简单起见，写死一个6人局配置)
// 你可以根据实际人数修改这里
const ROLE_CONFIG = ['Thief', 'Critter', 'Follower', 'GoodRat', 'GoodRat', 'GoodRat'];

io.on('connection', (socket) => {
    console.log('玩家连接:', socket.id);

    // 1. 玩家加入
    socket.on('join', (name) => {
        if (gamePhase !== 'waiting') return; // 游戏开始后不能进
        
        // 简单去重：如果名字一样，就在后面加个随机数
        if(players.find(p => p.name === name)) {
            name = name + '#' + Math.floor(Math.random()*100);
        }

        players.push({
            id: socket.id,
            name: name,
            role: '?',
            dice: 0,
            isFollower: false // 标记是否被选为同伙
        });
        io.emit('updateList', players);
    });

    // 2. 开始游戏
    socket.on('startGame', () => {
        if (players.length < 2) return; 

        gamePhase = 'night';
        assignRolesAndDice();
        
        // 告诉所有人：游戏开始了，顺便把最新的玩家列表(含身份)发下去
        // 注意：实际开发中，身份应该保密，只发给对应的人。但作为MVP，先全发方便调试。
        io.emit('gameStarted', players);
        
        // 启动夜晚流程！
        startNightPhase(1); 
    });

    // 3. 大盗选择同伙 (秘密通讯)
    socket.on('thiefChooseFollower', (targetId) => {
        // 安全检查：只有大盗能发这个指令
        const me = players.find(p => p.id === socket.id);
        if (!me || me.role !== 'Thief') return;

        console.log(`大盗选择了同伙: ${targetId}`);

        // 找到那个倒霉蛋，标记为同伙
        const target = players.find(p => p.id === targetId);
        if (target) {
            target.isFollower = true;
            // 【关键】只告诉这个倒霉蛋一个人！
            io.to(targetId).emit('secretMessage', {
                type: 'YouAreFollower',
                thiefName: me.name
            });
            // 也可以给大盗一个反馈
            socket.emit('secretMessage', {
                type: 'System',
                msg: `你成功选择了 ${target.name} 作为同伙`
            });
        }
    });
    
    // 断开连接处理
    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('updateList', players);
    });
});

// --- 🎲 辅助函数：发身份和骰子 ---
function assignRolesAndDice() {
    // 1. 准备身份
    let currentRoles = ROLE_CONFIG.slice(0, players.length);
    // 如果人多，身份不够，用 GoodRat 补齐
    while(currentRoles.length < players.length) {
        currentRoles.push('GoodRat');
    }
    // 打乱
    currentRoles.sort(() => Math.random() - 0.5);

    // 2. 分配
    players.forEach((p, index) => {
        p.role = currentRoles[index];
        p.dice = Math.floor(Math.random() * 6) + 1; // 1-6点
        p.isFollower = false;
        
        if (p.role === 'Thief') thiefId = p.id;
    });
    
    console.log("身份分配完毕:", players.map(p => `${p.name}(${p.role})`).join(', '));
}

// --- 🌙 辅助函数：自动流程控制 ---
function startNightPhase(hour) {
    currentHour = hour;

    // --- 阶段 1: 大盗选人 (我们设定在 7点 进行) ---
    if (hour === 7) {
        console.log("--- 7点: 大盗时间 ---");
        io.emit('nightHour', 7); // 广播7点，前端大盗界面会亮起

        // 给大盗 15秒 选择时间，比普通回合稍长一点
        setTimeout(() => {
            startNightPhase(8); // 进入天亮
        }, 15000); 
        return;
    }

    // --- 阶段 2: 天亮了 ---
    if (hour > 7) {
        console.log("--- 天亮了 ---");
        gamePhase = 'day';
        io.emit('phaseChange', 'day'); // 广播天亮，前端显示投票界面
        return;
    }

    // --- 阶段 3: 普通夜晚 (1-6点) ---
    console.log(`--- ${hour} 点 ---`);
    io.emit('nightHour', hour); // 广播时间

    // 10秒后自动进入下一个小时
    setTimeout(() => {
        startNightPhase(hour + 1);
    }, 10000); 
}

server.listen(3000, () => {
    console.log('🧀 服务器就绪: http://localhost:3000');
});