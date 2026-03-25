import { Server } from 'socket.io';
import { Entity, GameState, InputState, PieceType, Team, Wall, Position, EffectEvent } from '../types';

const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const TICK_RATE = 30;
const TICK_DT = 1000 / TICK_RATE;

const PLAYER_SPEED = 250;
const MINION_SPEED = 180;
const SKILL_DASH_SPEED = 1200;
const SKILL_DASH_DURATION = 0.2; // seconds

const dist = (p1: Position, p2: Position) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
const normalize = (p: Position) => {
  const len = Math.hypot(p.x, p.y);
  return len === 0 ? { x: 0, y: 0 } : { x: p.x / len, y: p.y / len };
};
const generateId = () => Math.random().toString(36).substring(2, 9);

export class GameEngine {
  private io: Server;
  public state: GameState;
  private inputs: Record<string, InputState> = {};
  private lastTick: number = Date.now();
  private dashStates: Record<string, { timeRemaining: number, angle: number }> = {};

  constructor(io: Server) {
    this.io = io;
    this.state = {
      players: {},
      minions: {},
      walls: this.generateWalls(),
      leaderboard: []
    };
    
    // Spawn initial neutrals
    for (let i = 0; i < 60; i++) {
      this.spawnNeutral();
    }
  }

  private generateWalls(): Wall[] {
    const walls: Wall[] = [];
    // Outer boundaries
    walls.push({ x: -50, y: -50, width: MAP_WIDTH + 100, height: 50 });
    walls.push({ x: -50, y: MAP_HEIGHT, width: MAP_WIDTH + 100, height: 50 });
    walls.push({ x: -50, y: 0, width: 50, height: MAP_HEIGHT });
    walls.push({ x: MAP_WIDTH, y: 0, width: 50, height: MAP_HEIGHT });
    
    // Internal ruins
    for (let i = 0; i < 20; i++) {
      walls.push({
        x: Math.random() * (MAP_WIDTH - 200) + 100,
        y: Math.random() * (MAP_HEIGHT - 200) + 100,
        width: Math.random() * 200 + 50,
        height: Math.random() * 200 + 50
      });
    }
    return walls;
  }

  private spawnNeutral() {
    const id = generateId();
    const type = Math.random() > 0.8 ? PieceType.ROOK : PieceType.PAWN;
    this.state.minions[id] = {
      id,
      type,
      team: Team.NEUTRAL,
      ownerId: null,
      pos: { x: Math.random() * MAP_WIDTH, y: Math.random() * MAP_HEIGHT },
      hp: type === PieceType.ROOK ? 150 : 50,
      maxHp: type === PieceType.ROOK ? 150 : 50,
      speed: MINION_SPEED * (type === PieceType.ROOK ? 0.8 : 1),
      radius: type === PieceType.ROOK ? 20 : 15,
      attackRange: 40,
      attackDamage: type === PieceType.ROOK ? 20 : 10,
      attackCooldown: type === PieceType.ROOK ? 1.5 : 1,
      lastAttackTime: 0,
      skillCooldown: 0,
      lastSkillTime: 0,
      isDead: false,
      facingAngle: Math.random() * Math.PI * 2,
      pushVelocity: { x: 0, y: 0 },
      lastHitTime: 0,
      score: 10,
      name: 'Neutral',
      armyCount: 0
    };
  }

  public addPlayer(id: string) {
    this.state.players[id] = {
      id,
      type: PieceType.KING,
      team: Team.PLAYER,
      ownerId: id,
      pos: { x: Math.random() * (MAP_WIDTH - 200) + 100, y: Math.random() * (MAP_HEIGHT - 200) + 100 },
      hp: 500,
      maxHp: 500,
      speed: PLAYER_SPEED,
      radius: 25,
      attackRange: 80,
      attackDamage: 30,
      attackCooldown: 0.5,
      lastAttackTime: 0,
      skillCooldown: 5,
      lastSkillTime: 0,
      isDead: false,
      facingAngle: 0,
      pushVelocity: { x: 0, y: 0 },
      lastHitTime: 0,
      score: 0,
      name: `Player ${id.substring(0, 4)}`,
      armyCount: 0
    };
    this.inputs[id] = { up: false, down: false, left: false, right: false, attack: false, skill: false, mouseX: 0, mouseY: 0 };
  }

  public removePlayer(id: string) {
    delete this.state.players[id];
    delete this.inputs[id];
    delete this.dashStates[id];
    
    // Convert their minions to neutral
    Object.values(this.state.minions).forEach(m => {
      if (m.ownerId === id) {
        m.ownerId = null;
        m.team = Team.NEUTRAL;
      }
    });
  }

  public handleInput(id: string, input: InputState) {
    this.inputs[id] = input;
  }

  private checkWallCollision(entity: Entity, newX: number, newY: number): Position {
    let finalX = newX;
    let finalY = newY;
    
    for (const wall of this.state.walls) {
      // Simple AABB vs Circle
      const closestX = Math.max(wall.x, Math.min(finalX, wall.x + wall.width));
      const closestY = Math.max(wall.y, Math.min(finalY, wall.y + wall.height));
      
      const distanceX = finalX - closestX;
      const distanceY = finalY - closestY;
      const distanceSquared = distanceX * distanceX + distanceY * distanceY;
      
      if (distanceSquared < entity.radius * entity.radius) {
        const distance = Math.sqrt(distanceSquared);
        if (distance === 0) continue; // Inside wall, shouldn't happen
        
        const overlap = entity.radius - distance;
        finalX += (distanceX / distance) * overlap;
        finalY += (distanceY / distance) * overlap;
      }
    }
    
    return { x: finalX, y: finalY };
  }

  private emitEffect(effect: EffectEvent) {
    this.io.emit('effect', effect);
  }

  public update() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    // Maintain neutral population
    if (Object.keys(this.state.minions).length < 80 && Math.random() < 0.05) {
      this.spawnNeutral();
    }

    // Update Players
    for (const id in this.state.players) {
      const player = this.state.players[id];
      const input = this.inputs[id];
      if (!player || !input || player.isDead) continue;

      // Handle Dash Skill
      if (input.skill && now - player.lastSkillTime > player.skillCooldown * 1000) {
        player.lastSkillTime = now;
        this.dashStates[id] = { timeRemaining: SKILL_DASH_DURATION, angle: player.facingAngle };
        this.emitEffect({ type: 'shake', intensity: 10 });
      }

      let dx = 0; let dy = 0;
      const dash = this.dashStates[id];
      
      if (dash && dash.timeRemaining > 0) {
        dx = Math.cos(dash.angle) * SKILL_DASH_SPEED;
        dy = Math.sin(dash.angle) * SKILL_DASH_SPEED;
        dash.timeRemaining -= dt;
        
        if (dash.timeRemaining <= 0) {
          // Dash end AoE
          this.emitEffect({ type: 'particle', x: player.pos.x, y: player.pos.y, count: 20, color: '#ef4444' });
          this.emitEffect({ type: 'shake', intensity: 15 });
          
          // Damage nearby enemies
          const allEntities = [...Object.values(this.state.players), ...Object.values(this.state.minions)];
          for (const target of allEntities) {
            if (target.id !== player.id && target.ownerId !== player.id && !target.isDead) {
              const d = dist(player.pos, target.pos);
              if (d < 120) {
                this.dealDamage(player, target, 100, normalize({ x: target.pos.x - player.pos.x, y: target.pos.y - player.pos.y }));
              }
            }
          }
        }
      } else {
        if (input.up) dy -= 1;
        if (input.down) dy += 1;
        if (input.left) dx -= 1;
        if (input.right) dx += 1;
        
        if (dx !== 0 || dy !== 0) {
          const norm = normalize({ x: dx, y: dy });
          dx = norm.x * player.speed;
          dy = norm.y * player.speed;
          player.facingAngle = Math.atan2(dy, dx);
        }
      }

      // Apply push velocity
      dx += player.pushVelocity.x;
      dy += player.pushVelocity.y;
      player.pushVelocity.x *= 0.8;
      player.pushVelocity.y *= 0.8;

      const newPos = this.checkWallCollision(player, player.pos.x + dx * dt, player.pos.y + dy * dt);
      player.pos = newPos;

      // Attack
      if (input.attack && now - player.lastAttackTime > player.attackCooldown * 1000 && (!dash || dash.timeRemaining <= 0)) {
        player.lastAttackTime = now;
        this.emitEffect({ type: 'particle', x: player.pos.x + Math.cos(player.facingAngle)*30, y: player.pos.y + Math.sin(player.facingAngle)*30, count: 5, color: '#ffffff' });
        
        const allEntities = [...Object.values(this.state.players), ...Object.values(this.state.minions)];
        for (const target of allEntities) {
          if (target.id !== player.id && target.ownerId !== player.id && !target.isDead) {
            const d = dist(player.pos, target.pos);
            if (d < player.attackRange) {
              const angleToTarget = Math.atan2(target.pos.y - player.pos.y, target.pos.x - player.pos.x);
              let angleDiff = Math.abs(angleToTarget - player.facingAngle);
              if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
              
              if (angleDiff < Math.PI / 3) {
                this.dealDamage(player, target, player.attackDamage, normalize({ x: target.pos.x - player.pos.x, y: target.pos.y - player.pos.y }));
              }
            }
          }
        }
      }
    }

    // Update Minions
    for (const id in this.state.minions) {
      const minion = this.state.minions[id];
      if (minion.isDead) continue;

      // Find target
      let target: Entity | null = null;
      let minDist = Infinity;
      
      const allEntities = [...Object.values(this.state.players), ...Object.values(this.state.minions)];
      for (const possibleTarget of allEntities) {
        if (possibleTarget.id !== minion.id && possibleTarget.ownerId !== minion.ownerId && !possibleTarget.isDead) {
          const d = dist(minion.pos, possibleTarget.pos);
          if (d < 600 && d < minDist) {
            minDist = d;
            target = possibleTarget;
          }
        }
      }

      let dx = 0; let dy = 0;
      if (target) {
        const dir = normalize({ x: target.pos.x - minion.pos.x, y: target.pos.y - minion.pos.y });
        minion.facingAngle = Math.atan2(dir.y, dir.x);
        
        if (minDist > minion.attackRange * 0.8) {
          dx = dir.x * minion.speed;
          dy = dir.y * minion.speed;
        } else if (now - minion.lastAttackTime > minion.attackCooldown * 1000) {
          // Attack
          minion.lastAttackTime = now;
          this.dealDamage(minion, target, minion.attackDamage, dir);
        }
      }

      dx += minion.pushVelocity.x;
      dy += minion.pushVelocity.y;
      minion.pushVelocity.x *= 0.8;
      minion.pushVelocity.y *= 0.8;

      const newPos = this.checkWallCollision(minion, minion.pos.x + dx * dt, minion.pos.y + dy * dt);
      minion.pos = newPos;
    }

    // Entity-Entity Collision (Push apart)
    const allEntities = [...Object.values(this.state.players), ...Object.values(this.state.minions)];
    for (let i = 0; i < allEntities.length; i++) {
      for (let j = i + 1; j < allEntities.length; j++) {
        const e1 = allEntities[i];
        const e2 = allEntities[j];
        if (e1.isDead || e2.isDead) continue;
        
        const d = dist(e1.pos, e2.pos);
        const minDist = e1.radius + e2.radius;
        if (d < minDist && d > 0) {
          const overlap = minDist - d;
          const dir = normalize({ x: e1.pos.x - e2.pos.x, y: e1.pos.y - e2.pos.y });
          
          e1.pos.x += dir.x * overlap * 0.5;
          e1.pos.y += dir.y * overlap * 0.5;
          e2.pos.x -= dir.x * overlap * 0.5;
          e2.pos.y -= dir.y * overlap * 0.5;
        }
      }
    }

    // Clean up dead entities
    for (const id in this.state.minions) {
      if (this.state.minions[id].isDead) {
        delete this.state.minions[id];
      }
    }
    
    // Update leaderboard and army counts
    this.updateLeaderboard();

    // Broadcast state
    this.io.volatile.emit('gameState', this.state);
  }

  private dealDamage(attacker: Entity, target: Entity, amount: number, dir: Position) {
    target.hp -= amount;
    target.lastHitTime = Date.now();
    target.pushVelocity = { x: dir.x * 300, y: dir.y * 300 };
    
    this.emitEffect({ type: 'damage', x: target.pos.x, y: target.pos.y, value: amount, color: target.team === Team.PLAYER ? '#ef4444' : '#ffffff' });
    this.emitEffect({ type: 'particle', x: target.pos.x, y: target.pos.y, count: 3, color: target.color });

    if (target.hp <= 0) {
      target.isDead = true;
      
      // Shogi Capture Mechanic
      if (target.type !== PieceType.KING) {
        // Convert to attacker's team
        const newId = generateId();
        const ownerId = attacker.ownerId || attacker.id;
        
        this.state.minions[newId] = {
          ...target,
          id: newId,
          team: Team.PLAYER,
          ownerId: ownerId,
          hp: target.maxHp,
          isDead: false,
          color: this.state.players[ownerId]?.color || '#ef4444'
        };
        
        if (this.state.players[ownerId]) {
          this.state.players[ownerId].score += target.score;
        }
      } else if (target.type === PieceType.KING) {
        // A player died
        const ownerId = attacker.ownerId || attacker.id;
        if (this.state.players[ownerId]) {
          this.state.players[ownerId].score += target.score + 500;
        }
        
        // Respawn player after 3 seconds
        setTimeout(() => {
          if (this.state.players[target.id]) {
            this.state.players[target.id].isDead = false;
            this.state.players[target.id].hp = this.state.players[target.id].maxHp;
            this.state.players[target.id].pos = { x: Math.random() * (MAP_WIDTH - 200) + 100, y: Math.random() * (MAP_HEIGHT - 200) + 100 };
            this.state.players[target.id].score = Math.floor(this.state.players[target.id].score / 2); // Lose half score
          }
        }, 3000);
        
        // Convert their minions to neutral
        Object.values(this.state.minions).forEach(m => {
          if (m.ownerId === target.id) {
            m.ownerId = null;
            m.team = Team.NEUTRAL;
            m.color = '#3b82f6'; // Blue for neutrals
          }
        });
      }
    }
  }

  private updateLeaderboard() {
    // Reset army counts
    Object.values(this.state.players).forEach(p => p.armyCount = 0);
    
    // Count armies
    Object.values(this.state.minions).forEach(m => {
      if (m.ownerId && this.state.players[m.ownerId]) {
        this.state.players[m.ownerId].armyCount++;
      }
    });

    this.state.leaderboard = Object.values(this.state.players)
      .map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }
}
