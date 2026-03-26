export enum PieceType {
  KING = 'KING',
  ROOK = 'ROOK',
  BISHOP = 'BISHOP',
  KNIGHT = 'KNIGHT',
  PAWN = 'PAWN',
}

export enum Team {
  RED = 'RED',
  BLUE = 'BLUE',
  NEUTRAL = 'NEUTRAL',
}

export interface PlayerInfo {
  id: string;
  name: string;
  team: Team;
  pos: Position;
  hp: number;
  maxHp: number;
  facingAngle: number;
  isDead: boolean;
}

export interface MultiplayerState {
  players: { [id: string]: PlayerInfo };
  minions: Entity[];
  roomCode: string;
  isHost: boolean;
  status: 'lobby' | 'playing';
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
  lastHitTime: number;
  lastDamagedBy?: string;
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
  player: Entity;
  remotePlayers: { [id: string]: Entity };
  allies: Entity[];
  enemies: Entity[];
  particles: Particle[];
  damageTexts: DamageText[];
  walls: Wall[];
  score: number;
  gameOver: boolean;
  gameWon: boolean;
  screenShake: number;
}
