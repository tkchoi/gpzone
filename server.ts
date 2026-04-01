import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const PORT = Number(process.env.PORT || 3000);
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1600;
const TICK_RATE = 1000 / 30;
const PLAYER_SKILL_COOLDOWN_MS = 50000; // 2% charge per second
const SKILL_CHARGE_BONUS_PER_CORRUPT_MS = 10000; // 20% per corrupted minion
const PLAYER_SKILL_RADIUS = 200;
const TIMED_MODE_DURATION_MS = 60 * 1000;
const TIMED_RESPAWN_DELAY_MS = 3000;
const DIST_DIR = path.join(__dirname, "dist");
const DIST_INDEX = path.join(DIST_DIR, "index.html");

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

if (process.env.NODE_ENV === "production" && fs.existsSync(DIST_INDEX)) {
  app.use(express.static(DIST_DIR));
  app.get("*", (_req, res) => {
    res.sendFile(DIST_INDEX);
  });
} else {
  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      message: "gpzone realtime server",
    });
  });
}

enum PieceType {
  KING = "KING",
  ROOK = "ROOK",
  BISHOP = "BISHOP",
  KNIGHT = "KNIGHT",
  PAWN = "PAWN",
}

enum Team {
  RED = "RED",
  BLUE = "BLUE",
  YELLOW = "YELLOW",
  BLACK = "BLACK",
  NEUTRAL = "NEUTRAL",
}

type Position = {
  x: number;
  y: number;
};

type Wall = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Entity = {
  id: string;
  type: PieceType;
  team: Team;
  ownerId?: string;
  lastProcessedInputSeq?: number;
  pos: Position;
  hp: number;
  maxHp: number;
  speed: number;
  radius: number;
  attackRange: number;
  attackDamage: number;
  attackCooldown: number;
  lastAttackTime: number;
  skillCooldown: number;
  lastSkillTime: number;
  isDead: boolean;
  facingAngle: number;
  pushVelocity: Position;
  spawnPos?: Position;
  respawnAt?: number | null;
  lastHitTime: number;
  lastDamagedBy?: string;
  lastDamageSource?: "attack" | "skill";
  color?: string;
  baseColor?: string;
  playerIndex?: number;
  name?: string;
};

type InputState = {
  seq: number;
  roundId?: number;
  clientTime: number;
  moveX: number;
  moveY: number;
  attack: boolean;
  skill: boolean;
};

type RoomState = {
  code: string;
  hostId: string;
  matchType: "coop" | "versus" | "timed";
  players: Record<string, Entity>;
  playerScores: Record<string, number>;
  inputs: Record<string, InputState>;
  inputQueues: Record<string, InputState[]>;
  allies: Entity[];
  enemies: Entity[];
  playerHistory: Record<string, Array<{ time: number; pos: Position }>>;
  walls: Wall[];
  score: number;
  gameOver: boolean;
  gameWon: boolean;
  screenShake: number;
  paused: boolean;
  status: "lobby" | "playing" | "gameover";
  timedEndsAt: number | null;
  roundId: number;
  loop: NodeJS.Timeout | null;
};

const INITIAL_WALLS: Wall[] = [
  { x: 0, y: 0, width: MAP_WIDTH, height: 60 },
  { x: 0, y: MAP_HEIGHT - 60, width: MAP_WIDTH, height: 60 },
  { x: 0, y: 0, width: 60, height: MAP_HEIGHT },
  { x: MAP_WIDTH - 60, y: 0, width: 60, height: MAP_HEIGHT },
  { x: 300, y: 300, width: 200, height: 150 },
  { x: 1100, y: 300, width: 200, height: 150 },
  { x: 600, y: 600, width: 400, height: 100 },
  { x: 300, y: 1000, width: 150, height: 300 },
  { x: 1150, y: 1000, width: 150, height: 300 },
  { x: 700, y: 900, width: 200, height: 200 },
];

const PLAYER_COLORS = [
  { top: "#3b82f6", base: "#1e3a8a", team: Team.BLUE }, // Blue
  { top: "#ef4444", base: "#7f1d1d", team: Team.RED },  // Red
  { top: "#eab308", base: "#854d0e", team: Team.YELLOW }, // Yellow
  { top: "#3f3f46", base: "#09090b", team: Team.BLACK }, // Black
];

const rooms: Record<string, RoomState> = {};

function randomId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sanitizePlayerName(name?: string): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 18);
}

function createPlayer(socketId: string, index: number, total: number, matchType: "coop" | "versus" | "timed", name?: string): Entity {
  const spawnPoints = [
    { x: MAP_WIDTH / 2, y: MAP_HEIGHT - 220, facingAngle: -Math.PI / 2 },
    { x: MAP_WIDTH / 2, y: 220, facingAngle: Math.PI / 2 },
    { x: 220, y: MAP_HEIGHT / 2, facingAngle: 0 },
    { x: MAP_WIDTH - 220, y: MAP_HEIGHT / 2, facingAngle: Math.PI },
  ];

  const selected = spawnPoints[index] ?? spawnPoints[index % spawnPoints.length];
  let spawn = { x: selected.x, y: selected.y };
  let facingAngle = selected.facingAngle;

  if (matchType !== "versus" && total <= 1) {
    // Single player or first player in coop often defaults to bottom
    spawn = { x: MAP_WIDTH / 2, y: MAP_HEIGHT - 220 };
    facingAngle = -Math.PI / 2;
  }

  const colorData = PLAYER_COLORS[index % PLAYER_COLORS.length];
  const team = colorData.team;

  return {
    id: socketId,
    type: PieceType.KING,
    team,
    ownerId: socketId,
    pos: spawn,
    hp: 300,
    maxHp: 300,
    speed: 10,
    radius: 24,
    attackRange: 90,
    attackDamage: 40,
    attackCooldown: 400,
    lastAttackTime: 0,
    skillCooldown: PLAYER_SKILL_COOLDOWN_MS,
    // Spawn with 50% skill charge.
    lastSkillTime: Date.now() - PLAYER_SKILL_COOLDOWN_MS / 2,
    isDead: false,
    facingAngle,
    pushVelocity: { x: 0, y: 0 },
    spawnPos: { ...spawn },
    respawnAt: null,
    lastHitTime: 0,
    lastProcessedInputSeq: 0,
    color: colorData.top,
    baseColor: colorData.base,
    playerIndex: index,
    name: sanitizePlayerName(name),
  };
}

function createBoss(): Entity {
  return {
    id: "boss",
    type: PieceType.KING,
    team: Team.RED,
    pos: { x: MAP_WIDTH / 2, y: 200 },
    hp: 1500,
    maxHp: 1500,
    speed: 2,
    radius: 35,
    attackRange: 120,
    attackDamage: 50,
    attackCooldown: 1500,
    lastAttackTime: 0,
    skillCooldown: 5000,
    lastSkillTime: 0,
    isDead: false,
    facingAngle: Math.PI / 2,
    pushVelocity: { x: 0, y: 0 },
    lastHitTime: 0,
  };
}

function createNeutralMinion(): Entity {
  const x = 100 + Math.random() * (MAP_WIDTH - 200);
  const y = 100 + Math.random() * (MAP_HEIGHT - 200);
  return {
    id: randomId("neutral"),
    type: PieceType.PAWN,
    team: Team.NEUTRAL,
    pos: { x, y },
    hp: 40,
    maxHp: 40,
    speed: 2.5,
    radius: 18,
    attackRange: 50,
    attackDamage: 10,
    attackCooldown: 1000,
    lastAttackTime: 0,
    skillCooldown: 0,
    lastSkillTime: 0,
    isDead: false,
    facingAngle: Math.random() * Math.PI * 2,
    pushVelocity: { x: 0, y: 0 },
    lastHitTime: 0,
  };
}

function isVersusRoom(room: RoomState) {
  return room.matchType !== "coop";
}

function getAllLivingPlayers(room: RoomState) {
  return Object.values(room.players).filter((player) => !player.isDead);
}

function getEnemyTargetsForOwner(room: RoomState, ownerId: string) {
  return [
    ...Object.values(room.players).filter((player) => player.ownerId !== ownerId && !player.isDead),
    ...room.allies.filter((ally) => ally.ownerId !== ownerId && !ally.isDead),
    ...room.enemies.filter((enemy) => !enemy.isDead),
  ];
}

function getTeamForOwner(room: RoomState, ownerId?: string): Team {
  if (!ownerId) return Team.BLUE;
  return room.players[ownerId]?.team ?? Team.BLUE;
}

function applySkillChargeBonusForMinionCapture(
  room: RoomState,
  ownerId: string | undefined,
  unit: Entity,
  damageSource: Entity["lastDamageSource"],
) {
  if (!ownerId || unit.type === PieceType.KING || damageSource !== "attack") return;
  const scorer = room.players[ownerId];
  if (!scorer) return;

  scorer.lastSkillTime = Math.max(
    Date.now() - scorer.skillCooldown,
    scorer.lastSkillTime - SKILL_CHARGE_BONUS_PER_CORRUPT_MS,
  );
}

function recordPlayerHistory(room: RoomState, time: number) {
  for (const [socketId, player] of Object.entries(room.players)) {
    if (!room.playerHistory[socketId]) {
      room.playerHistory[socketId] = [];
    }

    room.playerHistory[socketId].push({
      time,
      pos: { ...player.pos },
    });

    room.playerHistory[socketId] = room.playerHistory[socketId].filter(entry => time - entry.time <= 1000);
  }
}

function getHistoricalPlayerPosition(room: RoomState, socketId: string, targetTime: number) {
  const history = room.playerHistory[socketId];
  const current = room.players[socketId];
  if (!history?.length || !current) return current?.pos ?? { x: 0, y: 0 };

  let closest = history[0];
  for (const entry of history) {
    if (Math.abs(entry.time - targetTime) < Math.abs(closest.time - targetTime)) {
      closest = entry;
    }
  }

  return closest.pos;
}

function resolveWallCollision(entity: Entity, walls: Wall[]) {
  for (const wall of walls) {
    let testX = entity.pos.x;
    let testY = entity.pos.y;

    if (entity.pos.x < wall.x) testX = wall.x;
    else if (entity.pos.x > wall.x + wall.width) testX = wall.x + wall.width;

    if (entity.pos.y < wall.y) testY = wall.y;
    else if (entity.pos.y > wall.y + wall.height) testY = wall.y + wall.height;

    const distX = entity.pos.x - testX;
    const distY = entity.pos.y - testY;
    const distance = Math.sqrt(distX * distX + distY * distY);

    if (distance < entity.radius) {
      if (distance === 0) {
        entity.pos.y -= entity.radius;
      } else {
        const pushDist = entity.radius - distance;
        entity.pos.x += (distX / distance) * pushDist;
        entity.pos.y += (distY / distance) * pushDist;
      }
    }
  }
}

function applyMapBounds(entity: Entity) {
  const margin = 60 + entity.radius;
  entity.pos.x = clamp(entity.pos.x, margin, MAP_WIDTH - margin);
  entity.pos.y = clamp(entity.pos.y, margin, MAP_HEIGHT - margin);
}

function separateEntityPair(a: Entity, b: Entity) {
  if (a.isDead || b.isDead) return;
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const dist = Math.hypot(dx, dy);
  const minDist = a.radius + b.radius;
  if (dist >= minDist) return;

  const safeDist = dist < 0.0001 ? 0.0001 : dist;
  const nx = dx / safeDist;
  const ny = dy / safeDist;
  const overlap = minDist - safeDist;
  const pushEach = overlap * 0.35;

  a.pos.x -= nx * pushEach;
  a.pos.y -= ny * pushEach;
  b.pos.x += nx * pushEach;
  b.pos.y += ny * pushEach;
}

function resolveCharacterCollisions(room: RoomState) {
  const entities = [
    ...Object.values(room.players).filter((player) => !player.isDead),
    ...room.allies.filter((ally) => !ally.isDead),
    ...room.enemies.filter((enemy) => !enemy.isDead),
  ];

  for (let i = 0; i < entities.length; i += 1) {
    for (let j = i + 1; j < entities.length; j += 1) {
      separateEntityPair(entities[i], entities[j]);
    }
  }

  for (const entity of entities) {
    resolveWallCollision(entity, room.walls);
    applyMapBounds(entity);
  }
}

function liveBlueUnits(room: RoomState) {
  if (isVersusRoom(room)) {
    return [
      ...getAllLivingPlayers(room),
      ...room.allies.filter((ally) => !ally.isDead),
    ];
  }
  return [
    ...Object.values(room.players).filter((player) => !player.isDead),
    ...room.allies.filter((ally) => !ally.isDead),
  ];
}

function nearestTarget(entity: Entity, targets: Entity[]) {
  let closest: Entity | null = null;
  let minDist = Infinity;

  for (const target of targets) {
    if (target.isDead) continue;
    const dist = Math.hypot(target.pos.x - entity.pos.x, target.pos.y - entity.pos.y);
    if (dist < minDist) {
      minDist = dist;
      closest = target;
    }
  }

  return { closest, minDist };
}

function performMeleeAttack(attacker: Entity, target: Entity, now: number) {
  target.hp -= attacker.attackDamage;
  target.lastHitTime = now;
  target.lastDamagedBy = attacker.ownerId;
  target.lastDamageSource = "attack";
  const angle = Math.atan2(target.pos.y - attacker.pos.y, target.pos.x - attacker.pos.x);
  target.pushVelocity.x = Math.cos(angle) * 8;
  target.pushVelocity.y = Math.sin(angle) * 8;
  attacker.lastAttackTime = now;
}

function updateEnemyAI(room: RoomState, entity: Entity, now: number) {
  const targets = liveBlueUnits(room);
  const { closest, minDist } = nearestTarget(entity, targets);

  if (!closest) return;

  const angle = Math.atan2(closest.pos.y - entity.pos.y, closest.pos.x - entity.pos.x);
  entity.facingAngle = angle;

  if (entity.id === "boss") {
    const isBerserk = entity.hp < entity.maxHp * 0.4;
    const speed = isBerserk ? entity.speed * 1.5 : entity.speed;
    const coopLivingPlayers = isVersusRoom(room)
      ? 1
      : Math.max(1, Object.values(room.players).filter((player) => !player.isDead && player.hp > 0).length);
    const coopPressureMultiplier = isVersusRoom(room)
      ? 1
      : Math.pow(2.5, Math.max(0, coopLivingPlayers - 1));
    const cooldownBase = isBerserk ? entity.attackCooldown * 0.7 : entity.attackCooldown;
    const cooldown = Math.max(250, cooldownBase / coopPressureMultiplier);

    const skillCooldownBase = entity.skillCooldown;
    const skillCooldown = Math.max(900, skillCooldownBase / coopPressureMultiplier);

    if (now - entity.lastSkillTime > skillCooldown) {
      if (minDist > 150 && minDist < 600) {
        entity.lastSkillTime = now;
        entity.pushVelocity.x = Math.cos(angle) * (isBerserk ? 35 : 25);
        entity.pushVelocity.y = Math.sin(angle) * (isBerserk ? 35 : 25);
        room.screenShake = 20;
      } else if (room.allies.length > 0) {
        const corruptionRange = 320;
        let converted = false;
        for (let i = room.allies.length - 1; i >= 0; i -= 1) {
          const ally = room.allies[i];
          if (Math.hypot(ally.pos.x - entity.pos.x, ally.pos.y - entity.pos.y) < corruptionRange) {
            room.allies.splice(i, 1);
            room.enemies.push({
              ...ally,
              id: randomId("corrupt"),
              team: Team.RED,
              hp: ally.maxHp,
            });
            converted = true;
          }
        }
        if (converted) {
          entity.lastSkillTime = now;
          room.screenShake = 15;
        }
      }
    }

    if (minDist > entity.attackRange + closest.radius - 20) {
      let vx = Math.cos(angle) * speed;
      let vy = Math.sin(angle) * speed;
      for (const wall of room.walls) {
        const closestX = Math.max(wall.x, Math.min(entity.pos.x, wall.x + wall.width));
        const closestY = Math.max(wall.y, Math.min(entity.pos.y, wall.y + wall.height));
        const dx = entity.pos.x - closestX;
        const dy = entity.pos.y - closestY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100 && dist > 0) {
          const force = (100 - dist) / 100;
          vx += (dx / dist) * force * 3;
          vy += (dy / dist) * force * 3;
        }
      }
      entity.pos.x += vx;
      entity.pos.y += vy;
    } else if (now - entity.lastAttackTime > cooldown) {
      performMeleeAttack(entity, closest, now);
    }

    return;
  }

  if (minDist > entity.attackRange + closest.radius - 10) {
    entity.pos.x += Math.cos(angle) * entity.speed;
    entity.pos.y += Math.sin(angle) * entity.speed;
  } else if (now - entity.lastAttackTime > entity.attackCooldown) {
    performMeleeAttack(entity, closest, now);
  }
}

function updateAllies(room: RoomState, now: number) {
  for (let i = room.allies.length - 1; i >= 0; i -= 1) {
    const ally = room.allies[i];
    ally.pos.x += ally.pushVelocity.x;
    ally.pos.y += ally.pushVelocity.y;
    ally.pushVelocity.x *= 0.8;
    ally.pushVelocity.y *= 0.8;

    const targets = isVersusRoom(room)
      ? getEnemyTargetsForOwner(room, ally.ownerId ?? "")
      : room.enemies.filter((enemy) => !enemy.isDead);
    const { closest, minDist } = nearestTarget(ally, targets);
    if (closest) {
      const angle = Math.atan2(closest.pos.y - ally.pos.y, closest.pos.x - ally.pos.x);
      ally.facingAngle = angle;
      if (minDist > ally.attackRange + closest.radius - 10) {
        ally.pos.x += Math.cos(angle) * ally.speed;
        ally.pos.y += Math.sin(angle) * ally.speed;
      } else if (now - ally.lastAttackTime > ally.attackCooldown) {
        performMeleeAttack(ally, closest, now);
      }
    }

    resolveWallCollision(ally, room.walls);
    applyMapBounds(ally);

    if (ally.hp <= 0 && !isVersusRoom(room)) {
      room.allies.splice(i, 1);
    }
  }
}

function updatePlayers(room: RoomState, now: number) {
  for (const [socketId, player] of Object.entries(room.players)) {
    const queue = room.inputQueues[socketId] || [];

    if (player.hp <= 0 && !player.isDead) {
      player.hp = 0;
      player.isDead = true;
      if (player.lastDamagedBy && room.players[player.lastDamagedBy]) {
        room.playerScores[player.lastDamagedBy] = (room.playerScores[player.lastDamagedBy] || 0) + 1000;
      }
      if (room.matchType === "timed") {
        player.respawnAt = now + TIMED_RESPAWN_DELAY_MS;
        player.pushVelocity = { x: 0, y: 0 };
        if (player.spawnPos) {
          player.pos = { ...player.spawnPos };
        }
      }
    }

    if (player.isDead) {
      player.hp = 0;
      if (room.matchType === "timed") {
        if (player.respawnAt && now >= player.respawnAt) {
          player.isDead = false;
          player.hp = player.maxHp;
          // Respawn with 50% skill charge.
          player.lastSkillTime = now - player.skillCooldown / 2;
          player.respawnAt = null;
          player.lastDamagedBy = undefined;
          player.lastDamageSource = undefined;
          player.pushVelocity = { x: 0, y: 0 };
          if (player.spawnPos) {
            player.pos = { ...player.spawnPos };
          }
          room.inputQueues[socketId] = [];
          continue;
        }
        continue;
      }

      // Dead players can move as ghosts (visual only): no collision/combat impact.
      player.pushVelocity.x = 0;
      player.pushVelocity.y = 0;
      while (queue.length > 0) {
        const input = queue.shift()!;
        if (input.seq <= (player.lastProcessedInputSeq ?? 0)) continue;

        player.lastProcessedInputSeq = input.seq;
        room.inputs[socketId] = {
          ...input,
          attack: false,
          skill: false,
        };

        const magnitude = Math.hypot(input.moveX, input.moveY);
        if (magnitude > 0) {
          const moveX = input.moveX / magnitude;
          const moveY = input.moveY / magnitude;
          player.pos.x += moveX * player.speed;
          player.pos.y += moveY * player.speed;
          player.facingAngle = Math.atan2(moveY, moveX);
        }

        applyMapBounds(player);
      }
      continue;
    }

    if (queue.length === 0) {
      // Apply physics even with no input
      player.pos.x += player.pushVelocity.x;
      player.pos.y += player.pushVelocity.y;
      player.pushVelocity.x *= 0.8;
      player.pushVelocity.y *= 0.8;
      resolveWallCollision(player, room.walls);
      applyMapBounds(player);
    } else {
      // Process all pending inputs
      while (queue.length > 0) {
        const input = queue.shift()!;
        if (input.seq <= player.lastProcessedInputSeq) continue;
        
        player.lastProcessedInputSeq = input.seq;
        room.inputs[socketId] = input;

        const magnitude = Math.hypot(input.moveX, input.moveY);
        const moveX = magnitude > 0 ? input.moveX / magnitude : 0;
        const moveY = magnitude > 0 ? input.moveY / magnitude : 0;

        if (magnitude > 0) {
          player.pos.x += moveX * player.speed;
          player.pos.y += moveY * player.speed;
          player.facingAngle = Math.atan2(moveY, moveX);
        }

        player.pos.x += player.pushVelocity.x;
        player.pos.y += player.pushVelocity.y;
        player.pushVelocity.x *= 0.8;
        player.pushVelocity.y *= 0.8;

        resolveWallCollision(player, room.walls);
        applyMapBounds(player);

        // Process attack and skill per input
        if (input.attack && now - player.lastAttackTime > player.attackCooldown) {
          processPlayerAttack(room, socketId, player, input, now);
          player.lastAttackTime = now;
        }

        if (input.skill && now - player.lastSkillTime > player.skillCooldown) {
          processPlayerSkill(room, socketId, player, input, now);
        }
      }
    }
  }
}

function processPlayerAttack(room: RoomState, socketId: string, player: Entity, input: InputState, now: number) {
  const attackSpread = Math.PI / 1.5;
  const targets = isVersusRoom(room) ? getEnemyTargetsForOwner(room, socketId) : room.enemies;
  const lagCompMs = clamp(now - input.clientTime, 0, 150);
  // Attacker uses current authoritative position; targets may be rewound.
  const attackOrigin = player.pos;

  for (const enemy of targets) {
    // Apply lag compensation only to actual player targets, not allied minions.
    const isPlayerTarget = Boolean(room.players[enemy.id]);
    const targetPos = isVersusRoom(room) && isPlayerTarget
      ? getHistoricalPlayerPosition(room, enemy.id, now - lagCompMs)
      : enemy.pos;
    const dx = targetPos.x - attackOrigin.x;
    const dy = targetPos.y - attackOrigin.y;
    const dist = Math.hypot(dx, dy);
    if (dist > player.attackRange + enemy.radius) continue;

    let angleDiff = Math.abs(Math.atan2(dy, dx) - player.facingAngle);
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    angleDiff = Math.abs(angleDiff);

    if (angleDiff <= attackSpread / 2) {
      enemy.hp -= player.attackDamage;
      enemy.lastHitTime = now;
      enemy.lastDamagedBy = socketId;
      enemy.lastDamageSource = "attack";
      enemy.pushVelocity.x = Math.cos(Math.atan2(dy, dx)) * 10;
      enemy.pushVelocity.y = Math.sin(Math.atan2(dy, dx)) * 10;
    }
  }
}

function processPlayerSkill(room: RoomState, socketId: string, player: Entity, input: InputState, now: number) {
  // Skill charge consumed. 100% charge == 50s cooldown (2%/sec).
  player.lastSkillTime = now;
  room.screenShake = 25;
  player.pushVelocity.x = Math.cos(player.facingAngle) * 45;
  player.pushVelocity.y = Math.sin(player.facingAngle) * 45;
  const lagCompMs = clamp(now - input.clientTime, 0, 150);
  // Attacker uses current authoritative position; targets may be rewound.
  const skillOrigin = player.pos;

  if (isVersusRoom(room)) {
    let convertedBySkill = 0;
    const hostilePlayers = Object.values(room.players).filter((targetPlayer) => targetPlayer.ownerId !== socketId && !targetPlayer.isDead);
    for (const targetPlayer of hostilePlayers) {
      const targetPos = getHistoricalPlayerPosition(room, targetPlayer.ownerId ?? targetPlayer.id, now - lagCompMs);
      const dist = Math.hypot(targetPos.x - skillOrigin.x, targetPos.y - skillOrigin.y);
      if (dist < PLAYER_SKILL_RADIUS) {
        targetPlayer.hp -= 100;
        targetPlayer.lastHitTime = now;
        targetPlayer.lastDamagedBy = socketId;
        targetPlayer.lastDamageSource = "skill";
      }
    }

    for (let i = room.allies.length - 1; i >= 0; i -= 1) {
      const enemyUnit = room.allies[i];
      const dist = Math.hypot(enemyUnit.pos.x - skillOrigin.x, enemyUnit.pos.y - skillOrigin.y);
      if (dist >= PLAYER_SKILL_RADIUS || enemyUnit.ownerId === socketId) continue;
      enemyUnit.ownerId = socketId;
      enemyUnit.lastDamagedBy = socketId;
      enemyUnit.hp = enemyUnit.maxHp;
      enemyUnit.isDead = false;
      enemyUnit.pushVelocity = { x: 0, y: 0 };
      if (enemyUnit.type !== PieceType.KING) {
        convertedBySkill += 1;
      }
    }

    if (convertedBySkill > 0) {
      room.playerScores[socketId] = (room.playerScores[socketId] || 0) + convertedBySkill * 100;
    }
  }

  let convertedNeutrals = 0;
  for (let i = room.enemies.length - 1; i >= 0; i -= 1) {
    const enemy = room.enemies[i];
    const dist = Math.hypot(enemy.pos.x - skillOrigin.x, enemy.pos.y - skillOrigin.y);
    if (dist >= PLAYER_SKILL_RADIUS) continue;

    if (enemy.id === "boss") {
      enemy.hp -= 100;
      enemy.lastHitTime = now;
      enemy.lastDamagedBy = socketId;
      enemy.lastDamageSource = "skill";
      continue;
    }

    enemy.team = getTeamForOwner(room, socketId);
    enemy.ownerId = socketId;
    enemy.hp = enemy.maxHp;
    room.allies.push({
      ...enemy,
      id: randomId("ally"),
      pushVelocity: { x: 0, y: 0 },
      lastAttackTime: 0,
    });
    room.enemies.splice(i, 1);
    if (enemy.type !== PieceType.KING) {
      convertedNeutrals += 1;
    }
  }

  if (isVersusRoom(room) && convertedNeutrals > 0) {
    room.playerScores[socketId] = (room.playerScores[socketId] || 0) + convertedNeutrals * 100;
  }
}
function cleanupUnits(room: RoomState) {
  for (let i = room.enemies.length - 1; i >= 0; i -= 1) {
    const enemy = room.enemies[i];
    if (enemy.hp > 0) continue;

    if (enemy.lastDamagedBy && room.players[enemy.lastDamagedBy]) {
      room.playerScores[enemy.lastDamagedBy] = (room.playerScores[enemy.lastDamagedBy] || 0) + (enemy.type === PieceType.KING ? 500 : 100);
    }

    if (enemy.id === "boss") {
      room.gameWon = true;
      room.score += 5000;
    } else {
      room.score += 100;
      if (isVersusRoom(room)) {
        const ownerId = enemy.lastDamagedBy;
        if (ownerId && room.players[ownerId]) {
          room.playerScores[ownerId] = (room.playerScores[ownerId] || 0) + 100;
          applySkillChargeBonusForMinionCapture(room, ownerId, enemy, enemy.lastDamageSource);
          room.allies.push({
            ...enemy,
            id: randomId("ally"),
            team: getTeamForOwner(room, ownerId),
            ownerId,
            hp: enemy.maxHp,
            isDead: false,
            pushVelocity: { x: 0, y: 0 },
            lastAttackTime: 0,
          });
        }
      } else {
        room.allies.push({
          ...enemy,
          id: randomId("ally"),
          team: Team.BLUE,
          hp: enemy.maxHp,
          isDead: false,
          pushVelocity: { x: 0, y: 0 },
          lastAttackTime: 0,
        });
      }
    }

    room.enemies.splice(i, 1);
  }

  for (let i = room.allies.length - 1; i >= 0; i -= 1) {
    const ally = room.allies[i];
    if (ally.hp > 0) continue;

    if (isVersusRoom(room)) {
      const ownerId = ally.lastDamagedBy;
      if (ownerId && room.players[ownerId] && ownerId !== ally.ownerId) {
        applySkillChargeBonusForMinionCapture(room, ownerId, ally, ally.lastDamageSource);
        room.allies[i] = {
          ...ally,
          id: randomId("ally"),
          ownerId,
          hp: ally.maxHp,
          isDead: false,
          team: getTeamForOwner(room, ownerId),
          pushVelocity: { x: 0, y: 0 },
          lastAttackTime: 0,
        };
        continue;
      }
    }

    room.allies.splice(i, 1);
  }
}

function buildSnapshotForSocket(room: RoomState, socketId: string) {
  const localPlayer = room.players[socketId];
  const players = Object.fromEntries(
    Object.entries(room.players).map(([id, player]) => {
      // Keep original appearance (color, radius, type) and team
      return [id, { ...player }];
    }),
  );

  const allies = isVersusRoom(room)
    ? room.allies
        .filter((ally) => ally.ownerId === socketId)
        .map((ally) => ({ ...ally, team: getTeamForOwner(room, ally.ownerId) }))
    : room.allies.map((ally) => ({ ...ally, team: Team.BLUE }));

  const enemies = isVersusRoom(room)
    ? [
        ...room.allies
          .filter((ally) => ally.ownerId !== socketId)
          .map((ally) => ({ ...ally, team: getTeamForOwner(room, ally.ownerId) })),
        ...room.enemies.map((enemy) => ({ ...enemy })),
      ]
    : room.enemies.map((enemy) => ({ ...enemy }));

  const aliveOpponents = Object.values(room.players).filter(
    (player) => player.ownerId !== socketId && player.hp > 0 && !player.isDead,
  ).length;
  const alivePlayers = Object.values(room.players).filter((player) => player.hp > 0 && !player.isDead).length;
  const isRoundFinished = room.status === "gameover" || room.gameOver || room.gameWon;

  const timedScores = room.playerScores;
  const maxTimedScore = Math.max(0, ...Object.values(timedScores));
  const localTimedScore = timedScores[socketId] ?? 0;
  const isTimedWinner = localTimedScore === maxTimedScore;
  const gameOver = room.matchType === "timed"
    ? Boolean(isRoundFinished && !isTimedWinner)
    : (isVersusRoom(room)
      ? Boolean(isRoundFinished && localPlayer && (localPlayer.hp <= 0 || localPlayer.isDead))
      : room.gameOver);
  const gameWon = room.matchType === "timed"
    ? Boolean(isRoundFinished && isTimedWinner)
    : (isVersusRoom(room)
      ? Boolean(isRoundFinished && localPlayer && aliveOpponents === 0 && alivePlayers > 0 && !gameOver)
      : room.gameWon);

  return {
    players,
    playerScores: room.playerScores,
    allies,
    enemies,
    walls: room.walls,
    score: room.score,
    gameOver,
    gameWon,
    screenShake: room.screenShake,
    paused: room.paused,
    timedEndsAt: room.timedEndsAt,
    status: room.status,
    matchType: room.matchType,
    serverTime: Date.now(),
    roundId: room.roundId,
  };
}

function emitGameState(room: RoomState) {
  Object.keys(room.players).forEach((socketId) => {
    io.to(socketId).emit("game-state", buildSnapshotForSocket(room, socketId));
  });
}

function emitRoomUpdate(room: RoomState) {
  io.to(room.code).emit("room-update", {
    code: room.code,
    players: Object.entries(room.players).map(([id, p]) => ({ id, color: p.color, name: p.name })),
    hostId: room.hostId,
    status: room.status,
    matchType: room.matchType,
  });
}

function stopRoomLoop(room: RoomState) {
  if (room.loop) {
    clearInterval(room.loop);
    room.loop = null;
  }
}

function destroyRoom(code: string) {
  const room = rooms[code];
  if (!room) return;
  stopRoomLoop(room);
  delete rooms[code];
}

function tickRoom(room: RoomState) {
  if (room.status !== "playing" || room.gameOver || room.gameWon) {
    return;
  }
  if (room.paused) {
    return;
  }

  const now = Date.now();
  if (room.matchType === "timed" && room.timedEndsAt && now >= room.timedEndsAt) {
    room.status = "gameover";
    room.gameWon = true;
    stopRoomLoop(room);
    emitRoomUpdate(room);
    emitGameState(room);
    return;
  }
  room.screenShake *= 0.9;
  if (room.screenShake < 0.5) room.screenShake = 0;

  recordPlayerHistory(room, now);

  updatePlayers(room, now);
  updateAllies(room, now);

  for (const enemy of room.enemies) {
    enemy.pos.x += enemy.pushVelocity.x;
    enemy.pos.y += enemy.pushVelocity.y;
    enemy.pushVelocity.x *= 0.8;
    enemy.pushVelocity.y *= 0.8;
    updateEnemyAI(room, enemy, now);
    resolveWallCollision(enemy, room.walls);
    applyMapBounds(enemy);
  }

  resolveCharacterCollisions(room);

  cleanupUnits(room);

  if (isVersusRoom(room) && room.matchType !== "timed") {
    const alivePlayers = Object.values(room.players).filter((player) => player.hp > 0 && !player.isDead).length;
    if (alivePlayers <= 1) {
      room.gameWon = true;
    }
  } else if (Object.values(room.players).every((player) => player.hp <= 0 || player.isDead)) {
    room.gameOver = true;
  }

  recordPlayerHistory(room, now + 1);
  if (room.gameOver || room.gameWon) {
    room.status = "gameover";
    stopRoomLoop(room);
    emitRoomUpdate(room);
    emitGameState(room);
    return;
  }

  emitGameState(room);
}

function initializeRoomGame(room: RoomState) {
  stopRoomLoop(room);
  room.status = "playing";
  room.roundId += 1;
  room.score = 0;
  room.gameOver = false;
  room.gameWon = false;
  room.screenShake = 0;
  room.paused = false;
  room.timedEndsAt = room.matchType === "timed" ? Date.now() + TIMED_MODE_DURATION_MS : null;
  room.walls = INITIAL_WALLS.map((wall) => ({ ...wall }));
  room.allies = [];
  room.enemies = room.matchType === "coop" ? [createBoss()] : [];
  room.playerHistory = {};
  room.playerScores = Object.fromEntries(Object.keys(room.players).map(id => [id, 0]));

  const otherPlayerIds = Object.keys(room.players).filter((id) => id !== room.hostId);
  const sortedPlayerIds = [room.hostId, ...otherPlayerIds];
  const existingNames = Object.fromEntries(Object.entries(room.players).map(([id, player]) => [id, player.name]));
  room.players = Object.fromEntries(
    sortedPlayerIds.map((id, index) => [id, createPlayer(id, index, sortedPlayerIds.length, room.matchType, existingNames[id])]),
  );
  room.inputs = Object.fromEntries(
    sortedPlayerIds.map((id) => [
      id,
      { seq: 0, roundId: room.roundId, clientTime: Date.now(), moveX: 0, moveY: 0, attack: false, skill: false },
    ]),
  );
  room.inputQueues = Object.fromEntries(sortedPlayerIds.map((id) => [id, []]));
  recordPlayerHistory(room, Date.now());

  for (let i = 0; i < 20; i += 1) {
    room.enemies.push(createNeutralMinion());
  }

  room.loop = setInterval(() => tickRoom(room), TICK_RATE);
  io.to(room.code).emit("game-started", { roundId: room.roundId });
  emitRoomUpdate(room);
  emitGameState(room);
}

function createRoom(code: string, socketId: string, matchType: "coop" | "versus" | "timed"): RoomState {
  return {
    code,
    hostId: socketId,
    matchType,
    players: { [socketId]: createPlayer(socketId, 0, 1, matchType) },
    playerScores: { [socketId]: 0 },
    inputs: { [socketId]: { seq: 0, roundId: 0, clientTime: Date.now(), moveX: 0, moveY: 0, attack: false, skill: false } },
    inputQueues: { [socketId]: [] },
    allies: [],
    enemies: [],
    playerHistory: {},
    walls: INITIAL_WALLS.map((wall) => ({ ...wall })),
    score: 0,
    gameOver: false,
    gameWon: false,
    screenShake: 0,
    paused: false,
    status: "lobby",
    timedEndsAt: null,
    roundId: 0,
    loop: null,
  };
}

function detachSocketFromRooms(socketId: string) {
  for (const [code, room] of Object.entries(rooms)) {
    if (!room.players[socketId]) continue;

    delete room.players[socketId];
    delete room.playerScores[socketId];
    delete room.inputs[socketId];
    delete room.inputQueues[socketId];

    if (room.hostId === socketId) {
      const nextHost = Object.keys(room.players)[0];
      if (nextHost) {
        room.hostId = nextHost;
      }
    }

    if (Object.keys(room.players).length === 0) {
      destroyRoom(code);
      continue;
    }

    emitRoomUpdate(room);
    if (room.status === "playing") {
      emitGameState(room);
    }
  }
}

io.on("connection", (socket) => {
  socket.on("create-room", (payload?: { matchType?: "coop" | "versus" | "timed"; playerName?: string }) => {
    for (const room of socket.rooms) {
      if (rooms[room]) socket.leave(room);
    }
    detachSocketFromRooms(socket.id);
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const selectedMode = payload?.matchType;
    const matchType = selectedMode === "versus" || selectedMode === "timed" ? selectedMode : "coop";
    const room = createRoom(code, socket.id, matchType);
    room.players[socket.id].name = sanitizePlayerName(payload?.playerName);
    rooms[code] = room;
    socket.join(code);
    socket.emit("room-created", code);
    emitRoomUpdate(room);
  });

  socket.on("join-room", (payload: string | { code: string; playerName?: string }) => {
    for (const roomName of socket.rooms) {
      if (rooms[roomName]) socket.leave(roomName);
    }
    detachSocketFromRooms(socket.id);
    const code = typeof payload === "string" ? payload : payload.code;
    const playerName = typeof payload === "string" ? undefined : payload.playerName;
    if (!code || typeof code !== "string") {
      socket.emit("error-message", "Room code required");
      return;
    }
    const upperCode = code.toUpperCase();
    const room = rooms[upperCode];

    if (!room) {
      socket.emit("error-message", "Room not found");
      return;
    }

    if (room.status !== "lobby") {
      socket.emit("error-message", "Game already in progress");
      return;
    }

    if (Object.keys(room.players).length >= 4) {
      socket.emit("error-message", "Room is full (max 4 players)");
      return;
    }

    room.players[socket.id] = createPlayer(
      socket.id,
      Object.keys(room.players).length,
      Object.keys(room.players).length + 1,
      room.matchType,
      playerName,
    );
    room.playerScores[socket.id] = 0;
    room.inputs[socket.id] = { seq: 0, roundId: room.roundId, clientTime: Date.now(), moveX: 0, moveY: 0, attack: false, skill: false };
    room.inputQueues[socket.id] = [];
    socket.join(upperCode);
    socket.emit("room-joined", upperCode);
    emitRoomUpdate(room);
  });

  socket.on("leave-room", () => {
    detachSocketFromRooms(socket.id);
    for (const room of socket.rooms) {
      if (rooms[room]) {
        socket.leave(room);
      }
    }
  });

  socket.on("start-game", (code: string) => {
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 2) return;
    initializeRoomGame(room);
  });

  socket.on("retry-game", (code: string) => {
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return;
    initializeRoomGame(room);
  });

  socket.on("toggle-pause", (code: string) => {
    const room = rooms[code];
    if (!room) return;
    if (!room.players[socket.id]) return;
    if (room.status !== "playing" || room.gameOver || room.gameWon) return;

    room.paused = !room.paused;
    io.to(room.code).emit("room-paused", { code: room.code, paused: room.paused, by: socket.id });
    emitGameState(room);
  });

  socket.on("request-game-state", (code: string) => {
    const room = rooms[code];
    if (!room || room.status !== "playing" || !room.players[socket.id]) return;
    io.to(socket.id).emit("game-state", buildSnapshotForSocket(room, socket.id));
  });

  socket.on("player-input", (data: { roomCode: string; input: InputState }) => {
    const room = rooms[data.roomCode];
    if (!room || room.status !== "playing" || !room.inputs[socket.id]) return;
    if ((data.input.roundId ?? -1) !== room.roundId) return;
    const currentSeq = room.inputs[socket.id].seq;
    if (typeof data.input.seq !== "number" || data.input.seq < currentSeq) return;
    
    const newInput = {
      seq: data.input.seq,
      roundId: room.roundId,
      clientTime: typeof data.input.clientTime === "number" ? data.input.clientTime : Date.now(),
      moveX: clamp(data.input.moveX, -1, 1),
      moveY: clamp(data.input.moveY, -1, 1),
      attack: Boolean(data.input.attack),
      skill: Boolean(data.input.skill),
    };

    room.inputQueues[socket.id].push(newInput);
    // Keep queue manageable
    if (room.inputQueues[socket.id].length > 60) {
      room.inputQueues[socket.id] = room.inputQueues[socket.id].slice(-60);
    }
  });

  socket.on("disconnecting", () => {
    detachSocketFromRooms(socket.id);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
