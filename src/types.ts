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
