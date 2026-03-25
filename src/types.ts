export enum PieceType {
  KING = 'KING',
  ROOK = 'ROOK',
  BISHOP = 'BISHOP',
  KNIGHT = 'KNIGHT',
  PAWN = 'PAWN',
}

export enum Team {
  NEUTRAL = 'NEUTRAL',
  PLAYER = 'PLAYER',
}

export interface Position {
  x: number;
  y: number;
}

export interface Wall {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Entity {
  id: string;
  type: PieceType;
  team: Team;
  ownerId: string | null; // null if neutral
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
  lastHitTime: number;
  score: number;
  name: string;
  armyCount: number;
}

export interface Particle {
  id: string;
  pos: Position;
  vel: Position;
  color: string;
  life: number;
  maxLife: number;
  size: number;
}

export interface DamageText {
  id: string;
  pos: Position;
  vel: Position;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

export interface GameState {
  players: Record<string, Entity>;
  minions: Record<string, Entity>;
  walls: Wall[];
  leaderboard: { id: string, name: string, score: number }[];
}

export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  attack: boolean;
  skill: boolean;
  mouseX: number;
  mouseY: number;
}

export interface EffectEvent {
  type: 'damage' | 'particle' | 'shake';
  x?: number;
  y?: number;
  value?: number;
  color?: string;
  count?: number;
  intensity?: number;
}
