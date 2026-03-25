import React, { useEffect, useRef, useState } from 'react';
// Version: 1.0.1 - Force GitHub Sync (Color & Speed Fixes)
import { motion, AnimatePresence } from 'motion/react';
import { Sword, Zap, Skull, Play, Trophy, ShieldAlert, Pause, RotateCcw } from 'lucide-react';
import { PieceType, Team, Entity, Particle, DamageText, GameState, Wall } from './types';
import { soundManager } from './SoundManager';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1600;

// Hashima Island (Gunkanjima) style ruined concrete map
const INITIAL_WALLS: Wall[] = [
  // Outer boundaries
  { x: 0, y: 0, width: MAP_WIDTH, height: 60 },
  { x: 0, y: MAP_HEIGHT - 60, width: MAP_WIDTH, height: 60 },
  { x: 0, y: 0, width: 60, height: MAP_HEIGHT },
  { x: MAP_WIDTH - 60, y: 0, width: 60, height: MAP_HEIGHT },
  
  // Ruined Buildings / Corridors
  { x: 300, y: 300, width: 200, height: 150 },
  { x: 1100, y: 300, width: 200, height: 150 },
  { x: 600, y: 600, width: 400, height: 100 },
  { x: 300, y: 1000, width: 150, height: 300 },
  { x: 1150, y: 1000, width: 150, height: 300 },
  { x: 700, y: 900, width: 200, height: 200 },
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [uiState, setUiState] = useState({ score: 0, skillPercent: 0, gameOver: false, gameWon: false, allyCount: 0 });
  const requestRef = useRef<number>(null);
  const keysPressed = useRef<Set<string>>(new Set());
  const gameStateRef = useRef<GameState | null>(null);
  
  const isPlayingRef = useRef(false);
  const isPausedRef = useRef(false);
  const totalPausedTimeRef = useRef(0);
  const pauseStartTimeRef = useRef(0);
  
  const lastTimeRef = useRef<number>(0);
  const accumulatorRef = useRef<number>(0);
  const TIME_STEP = 1000 / 60; // 60 FPS fixed timestep

  const initGame = () => {
    const player: Entity = {
      id: 'player', type: PieceType.KING, team: Team.BLUE,
      pos: { x: MAP_WIDTH / 2, y: MAP_HEIGHT - 200 },
      hp: 300, maxHp: 300, speed: 5, radius: 24,
      attackRange: 90, attackDamage: 40, attackCooldown: 400, lastAttackTime: 0,
      skillCooldown: 4000, lastSkillTime: 0, isDead: false,
      facingAngle: -Math.PI / 2, pushVelocity: { x: 0, y: 0 }, lastHitTime: 0,
    };

    const boss: Entity = {
      id: 'boss', type: PieceType.KING, team: Team.RED,
      pos: { x: MAP_WIDTH / 2, y: 200 },
      hp: 1500, maxHp: 1500, speed: 2, radius: 35,
      attackRange: 120, attackDamage: 50, attackCooldown: 1500, lastAttackTime: 0,
      skillCooldown: 5000, lastSkillTime: 0, isDead: false,
      facingAngle: Math.PI / 2, pushVelocity: { x: 0, y: 0 }, lastHitTime: 0,
    };

    gameStateRef.current = {
      player, allies: [], enemies: [boss], particles: [], damageTexts: [], walls: INITIAL_WALLS,
      score: 0, gameOver: false, gameWon: false, screenShake: 0,
    };
    
    // Initial guards
    for(let i=0; i<8; i++) spawnEnemy(PieceType.PAWN);
    for(let i=0; i<4; i++) spawnEnemy(PieceType.KNIGHT);
    for(let i=0; i<2; i++) spawnEnemy(PieceType.ROOK);

    setUiState({ score: 0, skillPercent: 0, gameOver: false, gameWon: false, allyCount: 0 });
    
    totalPausedTimeRef.current = 0;
    pauseStartTimeRef.current = 0;
    lastTimeRef.current = performance.now();
    accumulatorRef.current = 0;
    isPausedRef.current = false;
    setIsPaused(false);
    isPlayingRef.current = true;
    setIsPlaying(true);
    soundManager.startBGM();
    
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    requestRef.current = requestAnimationFrame(update);
  };

  const togglePause = () => {
    if (!isPlayingRef.current || gameStateRef.current?.gameOver || gameStateRef.current?.gameWon) return;
    
    isPausedRef.current = !isPausedRef.current;
    setIsPaused(isPausedRef.current);
    
    if (isPausedRef.current) {
      pauseStartTimeRef.current = Date.now();
    } else {
      totalPausedTimeRef.current += Date.now() - pauseStartTimeRef.current;
      lastTimeRef.current = performance.now(); // Reset time to prevent huge delta
    }
  };

  const spawnEnemy = (type: PieceType) => {
    const state = gameStateRef.current;
    if (!state) return;
    
    // Spawn mostly in top half
    let x = 100 + Math.random() * (MAP_WIDTH - 200);
    let y = 100 + Math.random() * (MAP_HEIGHT / 2);
    
    let hp = 50, speed = 2, radius = 18, attackDamage = 15, attackRange = 50;
    
    if (type === PieceType.KNIGHT) { speed = 4; hp = 40; attackDamage = 20; }
    if (type === PieceType.ROOK) { speed = 1.5; hp = 120; radius = 22; attackDamage = 30; attackRange = 60; }
    if (type === PieceType.BISHOP) { speed = 2.5; hp = 60; attackDamage = 25; attackRange = 70; }

    state.enemies.push({
      id: Math.random().toString(36).substring(2, 9),
      type, team: Team.RED, pos: { x, y }, hp, maxHp: hp, speed, radius,
      attackRange, attackDamage, attackCooldown: 1200, lastAttackTime: 0,
      skillCooldown: 0, lastSkillTime: 0, isDead: false,
      facingAngle: Math.PI / 2, pushVelocity: { x: 0, y: 0 }, lastHitTime: 0,
    });
  };

  const spawnParticles = (x: number, y: number, color: string, count: number) => {
    const state = gameStateRef.current;
    if (!state) return;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 2;
      state.particles.push({
        id: Math.random().toString(), pos: { x, y },
        vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
        color, life: 0, maxLife: 20 + Math.random() * 20, size: Math.random() * 5 + 2
      });
    }
  };

  const spawnDamageText = (x: number, y: number, text: string, color: string) => {
    const state = gameStateRef.current;
    if (!state) return;
    state.damageTexts.push({
      id: Math.random().toString(), pos: { x, y },
      vel: { x: (Math.random() - 0.5) * 2, y: -2 - Math.random() * 2 },
      text, color, life: 0, maxLife: 40
    });
  };

  const resolveWallCollision = (entity: Entity, walls: Wall[]) => {
    walls.forEach(w => {
      let testX = entity.pos.x;
      let testY = entity.pos.y;
      
      if (entity.pos.x < w.x) testX = w.x;
      else if (entity.pos.x > w.x + w.width) testX = w.x + w.width;
      if (entity.pos.y < w.y) testY = w.y;
      else if (entity.pos.y > w.y + w.height) testY = w.y + w.height;

      let distX = entity.pos.x - testX;
      let distY = entity.pos.y - testY;
      let distance = Math.sqrt(distX * distX + distY * distY);

      if (distance < entity.radius) {
        if (distance === 0) {
          entity.pos.y -= entity.radius; // Push out arbitrarily if exactly inside
        } else {
          let pushDist = entity.radius - distance;
          entity.pos.x += (distX / distance) * pushDist;
          entity.pos.y += (distY / distance) * pushDist;
        }
      }
    });
  };

  const updateAI = (entity: Entity, targets: Entity[], now: number) => {
    const isBoss = entity.id === 'boss';
    const state = gameStateRef.current!;

    // Boss behavior
    if (entity.type === PieceType.KING && entity.team === Team.RED) {
      const distToPlayer = Math.hypot(state.player.pos.x - entity.pos.x, state.player.pos.y - entity.pos.y);
      
      // Berserk Mode: Faster and more aggressive when low HP
      const isBerserk = entity.hp < entity.maxHp * 0.4;
      const currentSpeed = isBerserk ? entity.speed * 1.5 : entity.speed;
      const currentCooldown = isBerserk ? entity.attackCooldown * 0.7 : entity.attackCooldown;

      if (Math.random() < 0.02 && state.enemies.length < 30) spawnEnemy(PieceType.PAWN);
      if (Math.random() < 0.01 && state.enemies.length < 30) spawnEnemy(PieceType.KNIGHT);

      // BOSS SKILLS
      const skillCD = isBerserk ? entity.skillCooldown * 0.6 : entity.skillCooldown;
      if (now - entity.lastSkillTime > skillCD) {
        // Priority 1: Charge at player if in range
        if (distToPlayer > 150 && distToPlayer < 600) {
          entity.lastSkillTime = now;
          const angle = Math.atan2(state.player.pos.y - entity.pos.y, state.player.pos.x - entity.pos.x);
          entity.pushVelocity.x = Math.cos(angle) * (isBerserk ? 35 : 25);
          entity.pushVelocity.y = Math.sin(angle) * (isBerserk ? 35 : 25);
          spawnParticles(entity.pos.x, entity.pos.y, '#ef4444', 40);
          spawnDamageText(entity.pos.x, entity.pos.y - 50, isBerserk ? "BERSERK CHARGE!" : "CHARGE!", '#ef4444');
          state.screenShake = 20;
          soundManager.playBossSkill();
        } 
        // Priority 2: Corruption Nova if allies are nearby
        else if (state.allies.length > 0) {
          const corruptionRange = 350;
          let corruptedCount = 0;
          for (let i = state.allies.length - 1; i >= 0; i--) {
            const ally = state.allies[i];
            if (Math.hypot(ally.pos.x - entity.pos.x, ally.pos.y - entity.pos.y) < corruptionRange) {
              entity.lastSkillTime = now;
              ally.team = Team.RED;
              ally.hp = ally.maxHp;
              state.enemies.push(ally);
              state.allies.splice(i, 1);
              spawnParticles(ally.pos.x, ally.pos.y, '#ef4444', 20);
              corruptedCount++;
            }
          }
          if (corruptedCount > 0) {
            spawnDamageText(entity.pos.x, entity.pos.y - 50, "CORRUPTION NOVA!", '#ef4444');
            state.screenShake = 15;
            soundManager.playBossSkill();
          }
        }
      }

      // Movement logic for Boss
      let target = state.player;
      let minDist = distToPlayer;

      // If player is too far or dead, find closest ally
      if (state.player.isDead || distToPlayer > 1000) {
        state.allies.forEach(a => {
          const d = Math.hypot(a.pos.x - entity.pos.x, a.pos.y - entity.pos.y);
          if (d < minDist) { minDist = d; target = a; }
        });
      }

      const angle = Math.atan2(target.pos.y - entity.pos.y, target.pos.x - entity.pos.x);
      
      // Aggressive Pursuit with Wall Avoidance
      if (minDist > entity.attackRange - 20) {
        let moveAngle = angle;
        
        // Strafing
        const strafeFactor = Math.sin(now / 400) * 0.6;
        moveAngle += strafeFactor;

        let vx = Math.cos(moveAngle) * currentSpeed;
        let vy = Math.sin(moveAngle) * currentSpeed;

        // Wall Repulsion for Boss
        state.walls.forEach(w => {
          const closestX = Math.max(w.x, Math.min(entity.pos.x, w.x + w.width));
          const closestY = Math.max(w.y, Math.min(entity.pos.y, w.y + w.height));
          const dx = entity.pos.x - closestX;
          const dy = entity.pos.y - closestY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist < 100 && dist > 0) { // Repulsion range
            const force = (100 - dist) / 100;
            vx += (dx / dist) * force * 3;
            vy += (dy / dist) * force * 3;
          }
        });

        entity.pos.x += vx;
        entity.pos.y += vy;
        entity.facingAngle = angle;
      } else {
        // Attack
        if (now - entity.lastAttackTime > currentCooldown) {
          entity.lastAttackTime = now;
          target.hp -= entity.attackDamage;
          target.lastHitTime = now;
          const pushAngle = Math.atan2(target.pos.y - entity.pos.y, target.pos.x - entity.pos.x);
          target.pushVelocity.x = Math.cos(pushAngle) * 10;
          target.pushVelocity.y = Math.sin(pushAngle) * 10;
          spawnDamageText(target.pos.x, target.pos.y - 30, entity.attackDamage.toString(), '#ef4444');
          soundManager.playHit();
        }
      }

      // Wall Avoidance: If too close to edge, push back towards center
      const margin = 100;
      if (entity.pos.x < margin) entity.pushVelocity.x += 2;
      if (entity.pos.x > MAP_WIDTH - margin) entity.pushVelocity.x -= 2;
      if (entity.pos.y < margin) entity.pushVelocity.y += 2;
      if (entity.pos.y > MAP_HEIGHT - margin) entity.pushVelocity.y -= 2;

    return; // Boss logic handled
    }

    let closest: Entity | null = null;
    let minDist = Infinity;

    if (!closest) {
      targets.forEach(t => {
        const d = Math.hypot(t.pos.x - entity.pos.x, t.pos.y - entity.pos.y);
        if (d < minDist) { minDist = d; closest = t; }
      });
    }

    if (closest) {
      let targetPos = { ...closest.pos };
      
      const angle = Math.atan2(targetPos.y - entity.pos.y, targetPos.x - entity.pos.x);
      
      if (minDist > entity.attackRange - 10) {
        let moveAngle = angle;
        
        entity.pos.x += Math.cos(moveAngle) * entity.speed;
        entity.pos.y += Math.sin(moveAngle) * entity.speed;
        entity.facingAngle = angle; // Still face the target
      } else {
        if (now - entity.lastAttackTime > entity.attackCooldown) {
          entity.lastAttackTime = now;
          closest.hp -= entity.attackDamage;
          closest.lastHitTime = now;
          closest.pushVelocity.x = Math.cos(angle) * 6;
          closest.pushVelocity.y = Math.sin(angle) * 6;
          spawnDamageText(closest.pos.x, closest.pos.y - 20, entity.attackDamage.toString(), entity.team === Team.BLUE ? '#3b82f6' : '#ef4444');
          if (entity.team === Team.BLUE) {
            soundManager.playAllyHit();
          } else {
            // Enemy attacking player or ally
            if (closest.id === 'player') {
              state.screenShake = 5;
            }
            soundManager.playHit();
          }
        }
      }
    }
  };

  const simulateStep = () => {
    if (!gameStateRef.current || gameStateRef.current.gameOver || gameStateRef.current.gameWon) return;
    const state = gameStateRef.current;
    const { player, allies, enemies, particles, damageTexts, walls } = state;
    const now = Date.now() - totalPausedTimeRef.current;

    // Player Movement
    let dx = 0; let dy = 0;
    if (keysPressed.current.has('ArrowUp') || keysPressed.current.has('w') || keysPressed.current.has('W')) dy -= 1;
    if (keysPressed.current.has('ArrowDown') || keysPressed.current.has('s') || keysPressed.current.has('S')) dy += 1;
    if (keysPressed.current.has('ArrowLeft') || keysPressed.current.has('a') || keysPressed.current.has('A')) dx -= 1;
    if (keysPressed.current.has('ArrowRight') || keysPressed.current.has('d') || keysPressed.current.has('D')) dx += 1;

    if (dx !== 0 || dy !== 0) {
      const mag = Math.sqrt(dx * dx + dy * dy);
      player.pos.x += (dx / mag) * player.speed;
      player.pos.y += (dy / mag) * player.speed;
      player.facingAngle = Math.atan2(dy, dx);
    }

    // Apply knockback
    player.pos.x += player.pushVelocity.x;
    player.pos.y += player.pushVelocity.y;
    player.pushVelocity.x *= 0.8;
    player.pushVelocity.y *= 0.8;

    resolveWallCollision(player, walls);

    // Player Attack (Z or J)
    if (keysPressed.current.has('z') || keysPressed.current.has('Z') || keysPressed.current.has('j') || keysPressed.current.has('J')) {
      if (now - player.lastAttackTime > player.attackCooldown) {
        player.lastAttackTime = now;
        soundManager.playSwing(); // Play swing sound even on miss
        const attackSpread = Math.PI / 1.5; // 120 degrees
        enemies.forEach(e => {
          const edx = e.pos.x - player.pos.x;
          const edy = e.pos.y - player.pos.y;
          const dist = Math.hypot(edx, edy);
          if (dist <= player.attackRange + e.radius) {
            let angleToEnemy = Math.atan2(edy, edx);
            let angleDiff = Math.abs(angleToEnemy - player.facingAngle);
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            angleDiff = Math.abs(angleDiff);
            
            if (angleDiff <= attackSpread / 2) {
              e.hp -= player.attackDamage;
              e.lastHitTime = now;
              e.pushVelocity.x = Math.cos(angleToEnemy) * 10;
              e.pushVelocity.y = Math.sin(angleToEnemy) * 10;
              spawnDamageText(e.pos.x, e.pos.y - 20, player.attackDamage.toString(), '#ffffff');
              spawnParticles(e.pos.x, e.pos.y, '#ffffff', 5);
              state.screenShake = 4;
              soundManager.playPlayerHit(); // Use PlayerHit for hit impact
            }
          }
        });
      }
    }

    // Player Skill (X or K) - Conversion Dash
    if (keysPressed.current.has('x') || keysPressed.current.has('X') || keysPressed.current.has('k') || keysPressed.current.has('K')) {
      if (now - player.lastSkillTime > player.skillCooldown) {
        player.lastSkillTime = now;
        state.screenShake = 25;
        soundManager.playSkill();
        
        // Dash forward
        player.pushVelocity.x = Math.cos(player.facingAngle) * 45;
        player.pushVelocity.y = Math.sin(player.facingAngle) * 45;
        
        spawnParticles(player.pos.x, player.pos.y, '#3b82f6', 50);
        
        const conversionRange = 300; // Increased range
        let convertedCount = 0;

        for (let i = enemies.length - 1; i >= 0; i--) {
          const enemy = enemies[i];
          if (enemy.id === 'boss') {
            // Boss takes massive damage instead of conversion
            const dist = Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);
            if (dist < conversionRange) {
              enemy.hp -= 300;
              enemy.lastHitTime = now;
              spawnDamageText(enemy.pos.x, enemy.pos.y - 50, '300', '#ef4444');
            }
            continue;
          }

          const dist = Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);
          if (dist < conversionRange) {
            // Convert to Ally
            enemy.team = Team.BLUE;
            enemy.hp = enemy.maxHp;
            allies.push(enemy);
            enemies.splice(i, 1);
            spawnParticles(enemy.pos.x, enemy.pos.y, '#3b82f6', 20);
            convertedCount++;
          }
        }

        if (convertedCount > 0) {
          spawnDamageText(player.pos.x, player.pos.y - 60, `CONVERTED ${convertedCount}!`, '#3b82f6');
          soundManager.playCapture();
        }
      }
    }

    // Update Allies
    for (let i = allies.length - 1; i >= 0; i--) {
      const ally = allies[i];
      ally.pos.x += ally.pushVelocity.x;
      ally.pos.y += ally.pushVelocity.y;
      ally.pushVelocity.x *= 0.8;
      ally.pushVelocity.y *= 0.8;
      
      updateAI(ally, enemies, now);
      resolveWallCollision(ally, walls);

      if (ally.hp <= 0) {
        spawnParticles(ally.pos.x, ally.pos.y, '#ef4444', 15);
        allies.splice(i, 1);
      }
    }

    // Update Enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const enemy = enemies[i];
      enemy.pos.x += enemy.pushVelocity.x;
      enemy.pos.y += enemy.pushVelocity.y;
      enemy.pushVelocity.x *= 0.8;
      enemy.pushVelocity.y *= 0.8;

      updateAI(enemy, [player, ...allies], now);
      resolveWallCollision(enemy, walls);

      if (enemy.hp <= 0) {
        state.score += (enemy.type === PieceType.KING ? 5000 : 100);
        
        if (enemy.type === PieceType.KING) {
          state.gameWon = true;
          spawnParticles(enemy.pos.x, enemy.pos.y, '#fbbf24', 100);
        } else {
          // SHOGI CAPTURE MECHANIC: Enemy becomes Ally
          allies.push({
            ...enemy,
            id: Math.random().toString(),
            team: Team.BLUE,
            hp: enemy.maxHp, // Restore HP upon capture
            isDead: false,
            lastAttackTime: 0,
            pushVelocity: { x: 0, y: 0 }
          });
          spawnParticles(enemy.pos.x, enemy.pos.y, '#3b82f6', 25);
          spawnDamageText(enemy.pos.x, enemy.pos.y - 40, "CAPTURED!", '#3b82f6');
          soundManager.playCapture();
        }
        enemies.splice(i, 1);
      }
    }

    // Update Particles & Texts
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.pos.x += p.vel.x; p.pos.y += p.vel.y; p.life++;
      if (p.life >= p.maxLife) particles.splice(i, 1);
    }
    for (let i = damageTexts.length - 1; i >= 0; i--) {
      const dt = damageTexts[i];
      dt.pos.x += dt.vel.x; dt.pos.y += dt.vel.y; dt.life++;
      if (dt.life >= dt.maxLife) damageTexts.splice(i, 1);
    }

    if (state.screenShake > 0) state.screenShake *= 0.9;
    if (state.screenShake < 0.5) state.screenShake = 0;

    if (player.hp <= 0) {
      state.gameOver = true;
      setIsPlaying(false);
      soundManager.playLoss();
      soundManager.stopBGM();
    }
    if (state.gameWon) {
      setIsPlaying(false);
      soundManager.playWin();
      soundManager.stopBGM();
    }

    const elapsed = now - player.lastSkillTime;
    const skillPercent = Math.min(100, (elapsed / player.skillCooldown) * 100);
    setUiState({ score: state.score, skillPercent, gameOver: state.gameOver, gameWon: state.gameWon, allyCount: allies.length });
  };

  const update = (time: number) => {
    if (!lastTimeRef.current) lastTimeRef.current = time;
    const deltaTime = time - lastTimeRef.current;
    lastTimeRef.current = time;

    if (!gameStateRef.current || gameStateRef.current.gameOver || gameStateRef.current.gameWon || isPausedRef.current) {
      requestRef.current = requestAnimationFrame(update);
      return;
    }

    accumulatorRef.current += deltaTime;
    if (accumulatorRef.current > 100) accumulatorRef.current = 100; // Cap to prevent spiral of death

    while (accumulatorRef.current >= TIME_STEP) {
      simulateStep();
      accumulatorRef.current -= TIME_STEP;
    }

    draw(gameStateRef.current, Date.now() - totalPausedTimeRef.current);
    requestRef.current = requestAnimationFrame(update);
  };

  const drawEntity = (ctx: CanvasRenderingContext2D, entity: Entity, now: number) => {
    ctx.save();
    ctx.translate(entity.pos.x, entity.pos.y);

    const isHit = now - entity.lastHitTime < 100;
    const isBlue = entity.team === Team.BLUE;
    const isBoss = entity.type === PieceType.KING && entity.team === Team.RED;
    
    let baseColor = isHit ? '#ffffff' : (isBlue ? '#1e3a8a' : '#7f1d1d');
    let topColor = isHit ? '#ffffff' : (isBlue ? '#3b82f6' : '#ef4444');
    
    if (isBoss) {
      baseColor = isHit ? '#ffffff' : '#450a0a';
      topColor = isHit ? '#ffffff' : '#b91c1c';
    }

    const height = entity.radius * 1.5;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.ellipse(0, entity.radius * 0.8, entity.radius, entity.radius * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';

    // Body (Cylinder)
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.arc(0, 0, entity.radius, 0, Math.PI);
    ctx.lineTo(entity.radius, -height);
    ctx.arc(0, -height, entity.radius, 0, Math.PI, true);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Top/Head
    ctx.fillStyle = topColor;
    ctx.beginPath();
    ctx.arc(0, -height, entity.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Visor/Face
    ctx.save();
    ctx.translate(0, -height);
    ctx.rotate(entity.facingAngle);
    ctx.fillStyle = isHit ? '#ff0000' : '#ffffff';
    ctx.beginPath();
    ctx.roundRect(entity.radius * 0.2, -entity.radius * 0.4, entity.radius * 0.6, entity.radius * 0.8, 4);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Crown for Kings
    if (entity.type === PieceType.KING) {
      ctx.fillStyle = isBlue ? '#fbbf24' : '#94a3b8';
      ctx.beginPath();
      ctx.moveTo(-entity.radius * 0.6, -height - entity.radius * 0.4);
      ctx.lineTo(-entity.radius * 0.8, -height - entity.radius * 1.4);
      ctx.lineTo(-entity.radius * 0.2, -height - entity.radius * 0.8);
      ctx.lineTo(0, -height - entity.radius * 1.6);
      ctx.lineTo(entity.radius * 0.2, -height - entity.radius * 0.8);
      ctx.lineTo(entity.radius * 0.8, -height - entity.radius * 1.4);
      ctx.lineTo(entity.radius * 0.6, -height - entity.radius * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Piece Type Label
    if (entity.type !== PieceType.KING) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px Inter';
      ctx.textAlign = 'center';
      ctx.fillText(entity.type[0], 0, -height + 4);
    }

    ctx.restore();

    // Health Bar
    const barWidth = entity.radius * 2.5;
    const barHeight = isBoss ? 12 : 8;
    ctx.save();
    ctx.translate(entity.pos.x, entity.pos.y - entity.radius * 3.2);
    
    ctx.fillStyle = '#000000';
    ctx.fillRect(-barWidth/2 - 2, -barHeight/2 - 2, barWidth + 4, barHeight + 4);
    
    const fillPercent = Math.max(0, entity.hp / entity.maxHp);
    ctx.fillStyle = isBlue ? '#22c55e' : (isBoss ? '#a855f7' : '#ef4444');
    ctx.fillRect(-barWidth/2, -barHeight/2, barWidth * fillPercent, barHeight);
    
    ctx.fillStyle = '#000000';
    const segmentHP = isBoss ? 250 : 50;
    const numSegments = Math.floor(entity.maxHp / segmentHP);
    for (let i = 1; i < numSegments; i++) {
      const segX = -barWidth/2 + (barWidth * (i * segmentHP) / entity.maxHp);
      ctx.fillRect(segX - 1, -barHeight/2, 2, barHeight);
    }
    ctx.restore();
  };

  const draw = (state: GameState, now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Camera logic: center on player, clamp to map bounds
    let camX = state.player.pos.x - CANVAS_WIDTH / 2;
    let camY = state.player.pos.y - CANVAS_HEIGHT / 2;
    camX = Math.max(0, Math.min(MAP_WIDTH - CANVAS_WIDTH, camX));
    camY = Math.max(0, Math.min(MAP_HEIGHT - CANVAS_HEIGHT, camY));

    ctx.save();
    
    // Screen Shake
    if (state.screenShake > 0) {
      const dx = (Math.random() - 0.5) * state.screenShake;
      const dy = (Math.random() - 0.5) * state.screenShake;
      ctx.translate(dx, dy);
    }

    // Background (Ocean/Abyss outside map)
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Apply Camera Transform
    ctx.translate(-camX, -camY);

    // Draw Hashima Island Floor
    ctx.fillStyle = '#27272a'; // Dark concrete
    ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Grid lines for tactical feel
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth = 2;
    for (let i = 0; i < MAP_WIDTH; i += 100) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, MAP_HEIGHT); ctx.stroke();
    }
    for (let i = 0; i < MAP_HEIGHT; i += 100) {
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(MAP_WIDTH, i); ctx.stroke();
    }

    // Draw Walls (Fake 3D)
    state.walls.forEach(w => {
      // Top face
      ctx.fillStyle = '#52525b';
      ctx.fillRect(w.x, w.y - 40, w.width, w.height);
      // Front face
      ctx.fillStyle = '#18181b';
      ctx.fillRect(w.x, w.y + w.height - 40, w.width, 40);
      
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3;
      ctx.strokeRect(w.x, w.y - 40, w.width, w.height);
      ctx.strokeRect(w.x, w.y + w.height - 40, w.width, 40);
    });

    // Sort entities by Y for fake 3D depth
    const allEntities = [state.player, ...state.allies, ...state.enemies].sort((a, b) => a.pos.y - b.pos.y);
    allEntities.forEach(e => drawEntity(ctx, e, now));

    // Attack Arc
    if (now - state.player.lastAttackTime < 150) {
      ctx.save();
      ctx.translate(state.player.pos.x, state.player.pos.y);
      ctx.rotate(state.player.facingAngle);
      ctx.beginPath();
      ctx.arc(0, 0, state.player.attackRange, -Math.PI / 3, Math.PI / 3);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 15;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }

    // Skill Effect
    if (now - state.player.lastSkillTime < 500) {
      const progress = (now - state.player.lastSkillTime) / 500;
      ctx.beginPath();
      ctx.arc(state.player.pos.x, state.player.pos.y, 300 * progress, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(59, 130, 246, ${1 - progress})`;
      ctx.lineWidth = 20 * (1 - progress);
      ctx.stroke();
      ctx.fillStyle = `rgba(59, 130, 246, ${(1 - progress) * 0.3})`;
      ctx.fill();
    }

    // Particles
    state.particles.forEach(p => {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = 1 - (p.life / p.maxLife);
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    });

    // Damage Texts
    state.damageTexts.forEach(dt => {
      ctx.fillStyle = dt.color;
      ctx.globalAlpha = 1 - (dt.life / dt.maxLife);
      ctx.font = 'black italic 22px Inter';
      ctx.textAlign = 'center';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 5;
      ctx.strokeText(dt.text, dt.pos.x, dt.pos.y);
      ctx.fillText(dt.text, dt.pos.x, dt.pos.y);
      ctx.globalAlpha = 1.0;
    });

    ctx.restore();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }
      if (e.key === 'Escape' || e.key.toLowerCase() === 'p') {
        togglePause();
      }
      keysPressed.current.add(e.key);
    };
    const handleKeyUp = (e: KeyboardEvent) => keysPressed.current.delete(e.key);
    const handleBlur = () => keysPressed.current.clear();

    window.addEventListener('keydown', handleKeyDown, { passive: false });
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  useEffect(() => {
    if (isPlaying && !isPausedRef.current) {
      requestRef.current = requestAnimationFrame(update);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isPlaying]);

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans flex flex-col items-center justify-center p-4 select-none">
      {/* Header */}
      <div className="w-full max-w-[800px] flex justify-between items-center mb-4 px-2">
        <div className="flex flex-col">
          <h1 className="text-5xl font-black tracking-tighter italic uppercase text-red-600 leading-none drop-shadow-md">
            DARK ZONE
          </h1>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs uppercase tracking-[0.3em] text-zinc-500 font-bold">
              Hashima Skirmish
            </span>
            <span className="bg-blue-600 text-white text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest">
              v1.0.2 (Blue Ally Patch)
            </span>
          </div>
        </div>
        <div className="flex gap-4 items-center">
          <div className="flex gap-6 items-center bg-zinc-900/80 px-6 py-2 rounded-2xl border-2 border-zinc-800">
            <div className="flex flex-col items-end">
              <span className="text-[10px] uppercase text-zinc-500 font-black tracking-wider">Score</span>
              <span className="text-2xl font-black italic text-white">{uiState.score}</span>
            </div>
            <div className="w-px h-8 bg-zinc-800"></div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] uppercase text-zinc-500 font-black tracking-wider">Blue Army</span>
              <span className="text-2xl font-black italic text-blue-500">{uiState.allyCount}</span>
            </div>
          </div>
          
          {/* Controls */}
          <div className="flex gap-2">
            <button 
              onClick={togglePause} 
              disabled={!isPlaying || uiState.gameOver || uiState.gameWon}
              className="p-3 bg-zinc-900/80 rounded-2xl border-2 border-zinc-800 hover:bg-zinc-800 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Pause (P or Esc)"
            >
              {isPaused ? <Play className="w-6 h-6" /> : <Pause className="w-6 h-6" />}
            </button>
            <button 
              onClick={initGame} 
              className="p-3 bg-zinc-900/80 rounded-2xl border-2 border-zinc-800 hover:bg-red-900/50 hover:border-red-800 text-white transition-colors"
              title="Restart"
            >
              <RotateCcw className="w-6 h-6" />
            </button>
          </div>
        </div>
      </div>

      {/* Game Canvas Container */}
      <div 
        className="relative border-8 border-zinc-900 rounded-3xl overflow-hidden shadow-[0_0_50px_rgba(220,38,38,0.15)]"
        onClick={() => window.focus()}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="bg-black block"
        />

        {/* Pause Overlay */}
        <AnimatePresence>
          {isPaused && !uiState.gameOver && !uiState.gameWon && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-40"
            >
              <h2 className="text-5xl font-black italic uppercase mb-8 text-white tracking-widest drop-shadow-lg">Paused</h2>
              <div className="flex gap-4">
                <button
                  onClick={togglePause}
                  className="bg-zinc-100 hover:bg-white text-black font-black italic text-xl uppercase px-8 py-4 rounded-2xl transition-all flex items-center justify-center gap-3 border-b-4 border-zinc-400 active:border-b-0 active:translate-y-1"
                >
                  <Play className="w-6 h-6 fill-current" />
                  Resume
                </button>
                <button
                  onClick={initGame}
                  className="bg-red-600 hover:bg-red-500 text-white font-black italic text-xl uppercase px-8 py-4 rounded-2xl transition-all flex items-center justify-center gap-3 border-b-4 border-red-800 active:border-b-0 active:translate-y-1"
                >
                  <RotateCcw className="w-6 h-6" />
                  Restart
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Start / Game Over Overlay */}
        <AnimatePresence>
          {!isPlaying && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-md flex flex-col items-center justify-center z-50"
            >
              <motion.div
                initial={{ scale: 0.8, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-zinc-900 p-10 rounded-3xl border-4 border-zinc-800 shadow-2xl text-center max-w-md w-full"
              >
                {uiState.gameOver ? (
                  <>
                    <Skull className="w-20 h-20 text-blue-600 mx-auto mb-4 drop-shadow-[0_0_15px_rgba(37,99,235,0.5)]" />
                    <h2 className="text-4xl font-black italic uppercase mb-2 text-white">Checkmate</h2>
                    <p className="text-zinc-400 mb-8 font-bold uppercase tracking-widest text-sm">The Blue King has fallen</p>
                  </>
                ) : uiState.gameWon ? (
                  <>
                    <Trophy className="w-20 h-20 text-yellow-500 mx-auto mb-4 drop-shadow-[0_0_15px_rgba(234,179,8,0.5)]" />
                    <h2 className="text-4xl font-black italic uppercase mb-2 text-white">Victory!</h2>
                    <p className="text-zinc-400 mb-8 font-bold uppercase tracking-widest text-sm">The Red King is defeated</p>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="w-20 h-20 text-red-600 mx-auto mb-4 drop-shadow-[0_0_15px_rgba(220,38,38,0.5)]" />
                    <h2 className="text-4xl font-black italic uppercase mb-2 text-white">Enter the Zone</h2>
                    <p className="text-zinc-400 mb-8 font-bold uppercase tracking-widest text-sm">Capture enemies to build your army</p>
                  </>
                )}

                <button
                  onClick={initGame}
                  className="w-full bg-red-600 hover:bg-red-500 text-white font-black italic text-xl uppercase py-5 rounded-2xl transition-all flex items-center justify-center gap-3 group border-b-4 border-red-800 active:border-b-0 active:translate-y-1"
                >
                  <Play className="w-6 h-6 fill-current" />
                  {uiState.gameOver || uiState.gameWon ? 'Play Again' : 'Start Battle'}
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* In-game HUD */}
        {isPlaying && (
          <div className="absolute bottom-6 right-6 flex gap-4 pointer-events-none">
            <div className="flex flex-col items-center">
              <div className="w-20 h-20 rounded-full bg-zinc-900/90 border-4 border-zinc-700 flex items-center justify-center relative overflow-hidden shadow-lg">
                <Sword className="w-10 h-10 text-zinc-300" />
                <div className="absolute bottom-1 text-[12px] font-black italic text-zinc-500">Z</div>
              </div>
              <span className="text-[12px] uppercase font-black tracking-widest mt-2 text-zinc-400 drop-shadow-md">Attack</span>
            </div>

            <div className="flex flex-col items-center">
              <div className="w-20 h-20 rounded-full bg-zinc-900/90 border-4 border-zinc-700 flex items-center justify-center relative overflow-hidden shadow-lg">
                <Zap className={`w-10 h-10 ${uiState.skillPercent >= 100 ? 'text-yellow-500 fill-yellow-500' : 'text-zinc-600'}`} />
                <div 
                  className="absolute inset-0 bg-black/70 transition-all duration-100"
                  style={{ height: `${100 - uiState.skillPercent}%` }}
                />
                <div className="absolute bottom-1 text-[12px] font-black italic text-zinc-500 z-10">X</div>
              </div>
              <span className="text-[12px] uppercase font-black tracking-widest mt-2 text-zinc-400 drop-shadow-md">Dash</span>
            </div>
          </div>
        )}
      </div>

      {/* Controls Help */}
      <div className="mt-8 grid grid-cols-3 gap-6 text-center max-w-[800px] w-full">
        <div className="bg-zinc-900/80 p-5 rounded-3xl border-2 border-zinc-800 flex flex-col items-center shadow-lg">
          <span className="block text-[11px] uppercase text-zinc-400 font-black tracking-widest mb-3">Move</span>
          <div className="flex flex-col items-center gap-1">
            <kbd className="w-10 h-10 flex items-center justify-center bg-zinc-800 rounded-xl text-lg font-black border-b-4 border-zinc-950 text-white">↑</kbd>
            <div className="flex gap-1">
              <kbd className="w-10 h-10 flex items-center justify-center bg-zinc-800 rounded-xl text-lg font-black border-b-4 border-zinc-950 text-white">←</kbd>
              <kbd className="w-10 h-10 flex items-center justify-center bg-zinc-800 rounded-xl text-lg font-black border-b-4 border-zinc-950 text-white">↓</kbd>
              <kbd className="w-10 h-10 flex items-center justify-center bg-zinc-800 rounded-xl text-lg font-black border-b-4 border-zinc-950 text-white">→</kbd>
            </div>
          </div>
        </div>
        <div className="bg-zinc-900/80 p-5 rounded-3xl border-2 border-zinc-800 flex flex-col items-center justify-center shadow-lg">
          <span className="block text-[11px] uppercase text-zinc-400 font-black tracking-widest mb-3">Attack</span>
          <kbd className="w-16 h-16 flex items-center justify-center bg-red-900/50 rounded-2xl text-2xl font-black italic border-b-4 border-red-950 text-red-500">Z</kbd>
        </div>
        <div className="bg-zinc-900/80 p-5 rounded-3xl border-2 border-zinc-800 flex flex-col items-center justify-center shadow-lg">
          <span className="block text-[11px] uppercase text-zinc-400 font-black tracking-widest mb-3">Skill (Dash)</span>
          <kbd className="w-16 h-16 flex items-center justify-center bg-yellow-900/50 rounded-2xl text-2xl font-black italic border-b-4 border-yellow-950 text-yellow-500">X</kbd>
        </div>
      </div>
    </div>
  );
}
