import React, { useEffect, useRef, useState } from 'react';
// Version: 1.1.0 - Multiplayer Support
import { motion, AnimatePresence } from 'motion/react';
import { Sword, Zap, Skull, Play, Trophy, ShieldAlert, Pause, RotateCcw, Users, UserPlus, LogIn, Copy, Check, LogOut } from 'lucide-react';
import { PieceType, Team, Entity, Particle, DamageText, GameState, Wall } from './types';
import { soundManager } from './SoundManager';
import { io, Socket } from 'socket.io-client';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1600;

type MultiplayerInputState = {
  seq: number;
  roundId: number;
  clientTime: number;
  moveX: number;
  moveY: number;
  attack: boolean;
  skill: boolean;
};

type MultiplayerSnapshot = {
  players: Record<string, Entity>;
  playerScores: Record<string, number>;
  allies: Entity[];
  enemies: Entity[];
  walls: Wall[];
  score: number;
  gameOver: boolean;
  gameWon: boolean;
  screenShake: number;
  status: 'lobby' | 'playing';
  matchType: 'coop' | 'versus';
  serverTime: number;
  roundId: number;
};

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
  const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL?.trim();
  const isLocalHost = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const socketUrl = configuredSocketUrl || (isLocalHost ? 'http://127.0.0.1:3000' : undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [uiState, setUiState] = useState({ score: 0, skillPercent: 0, gameOver: false, gameWon: false, allyCount: 0 });
  const requestRef = useRef<number>(null);
  const cameraRef = useRef({ x: 0, y: 0 });
  const attackReleaseTimeoutRef = useRef<number | null>(null);
  const skillReleaseTimeoutRef = useRef<number | null>(null);
  const keysPressed = useRef<Set<string>>(new Set());
  const gameStateRef = useRef<GameState | null>(null);
  
  // Mobile Control States
  const [joystick, setJoystick] = useState({ active: false, x: 0, y: 0, startX: 0, startY: 0 });
  const joystickRef = useRef({ x: 0, y: 0 });
  const [isMobile, setIsMobile] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  
  // Multiplayer States
  const [gameMode, setGameMode] = useState<'single' | 'multi' | null>(null);
  const [multiState, setMultiState] = useState<{
    roomCode: string;
    isHost: boolean;
    players: { id: string; color: string }[];
    status: 'lobby' | 'playing' | 'gameover';
    matchType: 'coop' | 'versus';
    error: string;
  }>({ roomCode: '', isHost: false, players: [], status: 'lobby', matchType: 'versus', error: '' });
  const [multiScores, setMultiScores] = useState<Record<string, number>>({});
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const multiInputRef = useRef<MultiplayerInputState>({ seq: 0, roundId: 0, clientTime: Date.now(), moveX: 0, moveY: 0, attack: false, skill: false });
  const multiOutcomeRef = useRef({ gameOver: false, gameWon: false });
  const gameModeRef = useRef<'single' | 'multi' | null>(null);
  const roomCodeRef = useRef('');
  const pendingAutoJoinRef = useRef('');
  const inputSeqRef = useRef(0);
  const roundIdRef = useRef(0);
  const pendingInputsRef = useRef<MultiplayerInputState[]>([]);
  const lastHitTimesRef = useRef<Record<string, number>>({});

  const isPlayingRef = useRef(false);
  const isPausedRef = useRef(false);
  const totalPausedTimeRef = useRef(0);
  const pauseStartTimeRef = useRef(0);
  
  const lastTimeRef = useRef<number>(0);
  const accumulatorRef = useRef<number>(0);
  const SINGLE_TIME_STEP = 1000 / 60;
  const MULTI_TIME_STEP = 1000 / 30;
  const MULTI_SPEED = 10;

  const createEmptyPlayer = (): Entity => ({
    id: 'player',
    type: PieceType.KING,
    team: Team.BLUE,
    lastProcessedInputSeq: 0,
    pos: { x: MAP_WIDTH / 2, y: MAP_HEIGHT - 200 },
    hp: 300,
    maxHp: 300,
    speed: 5,
    radius: 24,
    attackRange: 90,
    attackDamage: 40,
    attackCooldown: 400,
    lastAttackTime: 0,
    skillCooldown: 4000,
    lastSkillTime: 0,
    isDead: false,
    facingAngle: -Math.PI / 2,
    pushVelocity: { x: 0, y: 0 },
    lastHitTime: 0,
  });

  const createEmptyMultiplayerPlayer = (): Entity => ({
    ...createEmptyPlayer(),
    speed: MULTI_SPEED,
  });

  const applyLocalMapBounds = (entity: Entity) => {
    const margin = 60 + entity.radius;
    entity.pos.x = Math.max(margin, Math.min(MAP_WIDTH - margin, entity.pos.x));
    entity.pos.y = Math.max(margin, Math.min(MAP_HEIGHT - margin, entity.pos.y));
  };

  const applyPredictedMovement = (player: Entity, input: MultiplayerInputState, walls: Wall[]) => {
    const magnitude = Math.hypot(input.moveX, input.moveY);
    if (magnitude > 0) {
      const moveX = input.moveX / magnitude;
      const moveY = input.moveY / magnitude;
      player.pos.x += moveX * player.speed;
      player.pos.y += moveY * player.speed;
      player.facingAngle = Math.atan2(moveY, moveX);
    }

    player.pos.x += player.pushVelocity.x;
    player.pos.y += player.pushVelocity.y;
    player.pushVelocity.x *= 0.8;
    player.pushVelocity.y *= 0.8;

    resolveWallCollision(player, walls);
    applyLocalMapBounds(player);
  };

  const predictMultiplayerStep = () => {
    const state = gameStateRef.current;
    if (!state) return;

    const sampledInput = {
      ...multiInputRef.current,
      seq: inputSeqRef.current + 1,
      roundId: roundIdRef.current,
      clientTime: Date.now()
    };
    inputSeqRef.current = sampledInput.seq;
    multiInputRef.current = sampledInput;
    pendingInputsRef.current.push(sampledInput);
    if (pendingInputsRef.current.length > 120) {
      pendingInputsRef.current = pendingInputsRef.current.slice(-120);
    }

    if (gameModeRef.current === 'multi' && roomCodeRef.current) {
      socketRef.current?.emit('player-input', {
        roomCode: roomCodeRef.current,
        input: sampledInput
      });
    }

    applyPredictedMovement(state.player, sampledInput, state.walls);
  };

  const syncMultiInput = (patch: Partial<MultiplayerInputState> = {}) => {
    multiInputRef.current = {
      ...multiInputRef.current,
      ...patch,
    };
  };

  const clearTransientInputs = () => {
    keysPressed.current.clear();
    joystickRef.current = { x: 0, y: 0 };
    setJoystick({ active: false, x: 0, y: 0, startX: 0, startY: 0 });
    if (attackReleaseTimeoutRef.current !== null) {
      window.clearTimeout(attackReleaseTimeoutRef.current);
      attackReleaseTimeoutRef.current = null;
    }
    if (skillReleaseTimeoutRef.current !== null) {
      window.clearTimeout(skillReleaseTimeoutRef.current);
      skillReleaseTimeoutRef.current = null;
    }
  };

  const resetToMenu = (leaveMultiRoom = false) => {
    if (leaveMultiRoom && multiState.roomCode) {
      socketRef.current?.emit('leave-room');
    }
    clearTransientInputs();
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    isPlayingRef.current = false;
    setIsPlaying(false);
    setIsPaused(false);
    isPausedRef.current = false;
    soundManager.stopBGM();
    gameModeRef.current = null;
    roomCodeRef.current = '';
    pendingAutoJoinRef.current = '';
    window.history.replaceState({}, '', window.location.pathname);
    setGameMode(null);
    setJoinCode('');
    inputSeqRef.current = 0;
    roundIdRef.current = 0;
    pendingInputsRef.current = [];
    lastHitTimesRef.current = {};
    cameraRef.current = { x: 0, y: 0 };
    multiInputRef.current = { seq: 0, roundId: 0, clientTime: Date.now(), moveX: 0, moveY: 0, attack: false, skill: false };
    multiOutcomeRef.current = { gameOver: false, gameWon: false };
    setMultiState({ roomCode: '', isHost: false, players: [], status: 'lobby', matchType: 'versus', error: '' });
    setMultiScores({});
    gameStateRef.current = null;
    setUiState({ score: 0, skillPercent: 0, gameOver: false, gameWon: false, allyCount: 0 });
  };

  const applyMultiplayerSnapshot = (snapshot: MultiplayerSnapshot) => {
    const socketId = socketRef.current?.id;
    if (!socketId) return;
    if (snapshot.roundId < roundIdRef.current) return;
    setMultiState(prev => ({ ...prev, matchType: snapshot.matchType }));
    if (snapshot.roundId !== roundIdRef.current) {
      roundIdRef.current = snapshot.roundId;
      inputSeqRef.current = 0;
      pendingInputsRef.current = [];
      lastHitTimesRef.current = {};
      multiInputRef.current = {
        seq: 0,
        roundId: snapshot.roundId,
        clientTime: Date.now(),
        moveX: 0,
        moveY: 0,
        attack: false,
        skill: false,
      };
    }

    const authoritativePlayer = { ...(snapshot.players[socketId] ?? createEmptyMultiplayerPlayer()), id: 'player' };
    const lastProcessedInputSeq = authoritativePlayer.lastProcessedInputSeq ?? 0;
    pendingInputsRef.current = pendingInputsRef.current.filter((input) => input.seq > lastProcessedInputSeq);

    const replayedPlayer = {
      ...authoritativePlayer,
      pos: { ...authoritativePlayer.pos },
      pushVelocity: { ...authoritativePlayer.pushVelocity },
    };
    for (const input of pendingInputsRef.current) {
      applyPredictedMovement(replayedPlayer, input, snapshot.walls);
    }

    const currentDisplayedPlayer = gameStateRef.current?.player;
    const localPlayer = currentDisplayedPlayer
      ? {
          ...currentDisplayedPlayer,
          hp: replayedPlayer.hp,
          maxHp: replayedPlayer.maxHp,
          isDead: replayedPlayer.isDead,
          team: replayedPlayer.team,
          color: replayedPlayer.color,
          baseColor: replayedPlayer.baseColor,
          playerIndex: replayedPlayer.playerIndex,
          lastAttackTime: replayedPlayer.lastAttackTime,
          lastSkillTime: replayedPlayer.lastSkillTime,
          lastHitTime: replayedPlayer.lastHitTime,
          attackCooldown: replayedPlayer.attackCooldown,
          skillCooldown: replayedPlayer.skillCooldown,
          attackRange: replayedPlayer.attackRange,
          attackDamage: replayedPlayer.attackDamage,
          pushVelocity: { ...replayedPlayer.pushVelocity },
          lastProcessedInputSeq: replayedPlayer.lastProcessedInputSeq,
        }
      : replayedPlayer;

    if (currentDisplayedPlayer) {
      const dx = replayedPlayer.pos.x - currentDisplayedPlayer.pos.x;
      const dy = replayedPlayer.pos.y - currentDisplayedPlayer.pos.y;
      const dist = Math.hypot(dx, dy);

      if (dist < 0.1) {
        localPlayer.pos = { ...replayedPlayer.pos };
      } else if (dist < 600) {
        // Correct 15% of the error per snapshot to keep it smooth but convergent
        localPlayer.pos = {
          x: currentDisplayedPlayer.pos.x + dx * 0.15,
          y: currentDisplayedPlayer.pos.y + dy * 0.15,
        };
      } else {
        // Big jump, snap to server
        localPlayer.pos = { ...replayedPlayer.pos };
      }

      let facingDelta = replayedPlayer.facingAngle - currentDisplayedPlayer.facingAngle;
      while (facingDelta > Math.PI) facingDelta -= Math.PI * 2;
      while (facingDelta < -Math.PI) facingDelta += Math.PI * 2;
      
      localPlayer.facingAngle = Math.abs(facingDelta) < 0.01
        ? replayedPlayer.facingAngle
        : currentDisplayedPlayer.facingAngle + facingDelta * 0.2;
    }

    const remoteTargets: Record<string, Entity> = Object.fromEntries(
      (Object.entries(snapshot.players) as [string, Entity][])
        .filter(([id]) => id !== socketId)
        .map(([id, player]) => [id, { ...player, id: `remote-${id}` }])
    );

    const nextAllies = snapshot.allies.map((ally) => ({
      ...ally,
      pos: { ...ally.pos },
      pushVelocity: { ...ally.pushVelocity },
    }));

    const nextEnemies = snapshot.enemies.map((enemy) => ({
      ...enemy,
      pos: { ...enemy.pos },
      pushVelocity: { ...enemy.pushVelocity },
    }));

    const nextEntitiesForHitFx = [
      localPlayer,
      ...Object.values(remoteTargets),
      ...nextAllies,
      ...nextEnemies,
    ];

    gameStateRef.current = {
      player: localPlayer,
      remotePlayers: remoteTargets,
      playerScores: snapshot.playerScores,
      allies: nextAllies,
      enemies: nextEnemies,
      particles: gameStateRef.current?.particles ?? [],
      damageTexts: gameStateRef.current?.damageTexts ?? [],
      walls: snapshot.walls,
      score: snapshot.score,
      gameOver: snapshot.gameOver,
      gameWon: snapshot.gameWon,
      screenShake: snapshot.screenShake,
    };
    setMultiScores(snapshot.playerScores);

    for (const entity of nextEntitiesForHitFx) {
      const previousLastHitTime = lastHitTimesRef.current[entity.id] ?? 0;
      if (entity.lastHitTime > previousLastHitTime) {
        spawnParticles(
          entity.pos.x,
          entity.pos.y,
          entity.team === Team.BLUE ? '#3b82f6' : 
          (entity.team === Team.RED ? '#ef4444' : 
          (entity.team === Team.YELLOW ? '#eab308' : 
          (entity.team === Team.BLACK ? '#3f3f46' : 
          (entity.team === Team.NEUTRAL ? '#d1d5db' : '#ef4444')))),
          entity.type === PieceType.KING ? 10 : 6
        );
      }
      lastHitTimesRef.current[entity.id] = entity.lastHitTime;
    }

    const elapsed = Math.max(0, Date.now() - localPlayer.lastSkillTime);
    const skillPercent = Math.min(100, (elapsed / localPlayer.skillCooldown) * 100);

    if (!multiOutcomeRef.current.gameWon && snapshot.gameWon) {
      soundManager.playWin();
      soundManager.stopBGM();
    }
    if (!multiOutcomeRef.current.gameOver && snapshot.gameOver) {
      soundManager.playLoss();
      soundManager.stopBGM();
    }
    multiOutcomeRef.current = { gameOver: snapshot.gameOver, gameWon: snapshot.gameWon };

    setUiState({
      score: snapshot.playerScores[socketId] ?? 0,
      skillPercent,
      gameOver: snapshot.gameOver,
      gameWon: snapshot.gameWon,
      allyCount: snapshot.allies.length
    });
  };

  const initGame = (mode: 'single' | 'multi' = 'single') => {
    keysPressed.current.clear();
    joystickRef.current = { x: 0, y: 0 };
    setJoystick({ active: false, x: 0, y: 0, startX: 0, startY: 0 });

    if (mode === 'multi') {
      inputSeqRef.current = 0;
      roundIdRef.current = 0;
      pendingInputsRef.current = [];
      multiInputRef.current = { seq: 0, roundId: 0, clientTime: Date.now(), moveX: 0, moveY: 0, attack: false, skill: false };
      multiOutcomeRef.current = { gameOver: false, gameWon: false };
      setUiState({ score: 0, skillPercent: 0, gameOver: false, gameWon: false, allyCount: 0 });
      setMultiScores({});
      gameStateRef.current = {
        player: createEmptyMultiplayerPlayer(),
        remotePlayers: {},
        allies: [],
        enemies: [],
        particles: [],
        damageTexts: [],
        walls: INITIAL_WALLS,
        score: 0,
        gameOver: false,
        gameWon: false,
        screenShake: 0,
      };
      cameraRef.current = { x: 0, y: 0 };
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
      return;
    }

    const player: Entity = createEmptyPlayer();

    const boss: Entity = {
      id: 'boss', type: PieceType.KING, team: Team.RED,
      pos: { x: MAP_WIDTH / 2, y: 200 },
      hp: 1500, maxHp: 1500, speed: 2, radius: 35,
      attackRange: 120, attackDamage: 50, attackCooldown: 1500, lastAttackTime: 0,
      skillCooldown: 5000, lastSkillTime: 0, isDead: false,
      facingAngle: Math.PI / 2, pushVelocity: { x: 0, y: 0 }, lastHitTime: 0,
    };

    gameStateRef.current = {
      player, remotePlayers: {}, allies: [], enemies: [boss], particles: [], damageTexts: [], walls: INITIAL_WALLS,
      score: 0, gameOver: false, gameWon: false, screenShake: 0,
    };
    cameraRef.current = {
      x: Math.max(0, Math.min(Math.max(0, MAP_WIDTH - canvasSize.width), player.pos.x - canvasSize.width / 2)),
      y: Math.max(0, Math.min(Math.max(0, MAP_HEIGHT - canvasSize.height), player.pos.y - canvasSize.height / 2)),
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
    if (gameModeRef.current === 'multi') return;
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

  const spawnNeutralMinion = () => {
    const state = gameStateRef.current;
    if (!state) return;
    
    const x = 100 + Math.random() * (MAP_WIDTH - 200);
    const y = 100 + Math.random() * (MAP_HEIGHT - 200);
    
    const minion: Entity = {
      id: 'neutral-' + Math.random().toString(36).substr(2, 9),
      type: PieceType.PAWN,
      team: Team.NEUTRAL,
      pos: { x, y },
      hp: 40, maxHp: 40, speed: 2.5, radius: 18,
      attackRange: 50, attackDamage: 10, attackCooldown: 1000, lastAttackTime: 0,
      skillCooldown: 0, lastSkillTime: 0, isDead: false,
      facingAngle: Math.random() * Math.PI * 2,
      pushVelocity: { x: 0, y: 0 }, lastHitTime: 0,
    };
    state.enemies.push(minion);
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
      id: Math.random().toString(),
      type,
      team: Team.RED,
      pos: { x, y },
      hp, maxHp: hp, speed, radius,
      attackRange, attackDamage, attackCooldown: 1000, lastAttackTime: 0,
      skillCooldown: 0, lastSkillTime: 0, isDead: false,
      facingAngle: Math.PI / 2,
      pushVelocity: { x: 0, y: 0 }, lastHitTime: 0,
    });
  };

  const createRoom = () => {
    if (!socketRef.current?.connected) {
      setMultiState(prev => ({ ...prev, error: 'Server connection unavailable' }));
      return;
    }
    setMultiState(prev => ({ ...prev, error: '' }));
    socketRef.current?.emit('create-room', { matchType: 'versus' });
  };

  const normalizeJoinCode = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return '';

    try {
      const parsedUrl = new URL(trimmed);
      const roomParam = Array.from(parsedUrl.searchParams.entries()).find(
        ([key]) => key.toLowerCase() === 'room'
      )?.[1];
      if (roomParam) {
        return roomParam.toUpperCase();
      }
    } catch {
      // Plain room code input should fall through.
    }

    const roomMatch = trimmed.match(/[?&]room=([^&#]+)/i);
    if (roomMatch?.[1]) {
      return decodeURIComponent(roomMatch[1]).toUpperCase();
    }

    return trimmed.toUpperCase();
  };

  const joinRoom = () => {
    const normalizedCode = normalizeJoinCode(joinCode);
    if (normalizedCode) {
      if (!socketRef.current?.connected) {
        setMultiState(prev => ({ ...prev, error: 'Server connection unavailable' }));
        return;
      }
      setMultiState(prev => ({ ...prev, error: '' }));
      setJoinCode(normalizedCode);
      socketRef.current?.emit('join-room', normalizedCode);
    }
  };

  const leaveRoom = () => {
    socketRef.current?.emit('leave-room');
    clearTransientInputs();
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    isPlayingRef.current = false;
    setIsPlaying(false);
    setIsPaused(false);
    isPausedRef.current = false;
    soundManager.stopBGM();
    roomCodeRef.current = '';
    inputSeqRef.current = 0;
    roundIdRef.current = 0;
    pendingInputsRef.current = [];
    multiInputRef.current = { seq: 0, roundId: 0, clientTime: Date.now(), moveX: 0, moveY: 0, attack: false, skill: false };
    multiOutcomeRef.current = { gameOver: false, gameWon: false };
    gameStateRef.current = null;
    setUiState({ score: 0, skillPercent: 0, gameOver: false, gameWon: false, allyCount: 0 });
    setMultiScores({});
    setGameMode(null);
    setJoinCode('');
    setMultiState({ roomCode: '', isHost: false, players: [], status: 'lobby', matchType: 'versus', error: '' });
  };

  const startGameMulti = () => {
    const code = roomCodeRef.current || multiState.roomCode;
    if (!socketRef.current?.connected) {
      setMultiState(prev => ({ ...prev, error: 'Server connection unavailable' }));
      return;
    }
    if (!code) {
      setMultiState(prev => ({ ...prev, error: 'Room code unavailable' }));
      return;
    }
    socketRef.current.emit('start-game', code);
  };

  const retryGameMulti = () => {
    const code = roomCodeRef.current || multiState.roomCode;
    if (!socketRef.current?.connected) {
      setMultiState(prev => ({ ...prev, error: 'Server connection unavailable' }));
      return;
    }
    if (!code) {
      setMultiState(prev => ({ ...prev, error: 'Room code unavailable' }));
      return;
    }
    socketRef.current.emit('retry-game', code);
  };

  const copyRoomCode = () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${multiState.roomCode}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

  const updateVisualEffects = (state: GameState, stepScale = 1) => {
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const particle = state.particles[i];
      particle.pos.x += particle.vel.x * stepScale;
      particle.pos.y += particle.vel.y * stepScale;
      particle.life += stepScale;
      if (particle.life >= particle.maxLife) state.particles.splice(i, 1);
    }

    for (let i = state.damageTexts.length - 1; i >= 0; i--) {
      const damageText = state.damageTexts[i];
      damageText.pos.x += damageText.vel.x * stepScale;
      damageText.pos.y += damageText.vel.y * stepScale;
      damageText.life += stepScale;
      if (damageText.life >= damageText.maxLife) state.damageTexts.splice(i, 1);
    }
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
    if (gameMode === 'multi') return;
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

    const currentSpeed = player.speed;
    if (dx !== 0 || dy !== 0) {
      const mag = Math.sqrt(dx * dx + dy * dy);
      player.pos.x += (dx / mag) * currentSpeed;
      player.pos.y += (dy / mag) * currentSpeed;
      player.facingAngle = Math.atan2(dy, dx);
    } else if (joystickRef.current.x !== 0 || joystickRef.current.y !== 0) {
      // Mobile Joystick Movement
      player.pos.x += joystickRef.current.x * currentSpeed;
      player.pos.y += joystickRef.current.y * currentSpeed;
      player.facingAngle = Math.atan2(joystickRef.current.y, joystickRef.current.x);
    }

    // Apply knockback
    player.pos.x += player.pushVelocity.x;
    player.pos.y += player.pushVelocity.y;
    player.pushVelocity.x *= 0.8;
    player.pushVelocity.y *= 0.8;

    resolveWallCollision(player, walls);
    
    // Strict Map Bound Check (Outer wall thickness is 60)
    const margin = 60 + player.radius;
    player.pos.x = Math.max(margin, Math.min(MAP_WIDTH - margin, player.pos.x));
    player.pos.y = Math.max(margin, Math.min(MAP_HEIGHT - margin, player.pos.y));

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

      const potentialTargets = [player, ...allies, ...Object.values(state.remotePlayers)];
      updateAI(enemy, potentialTargets, now);
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

    updateVisualEffects(state);

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
    const currentTimeStep = gameModeRef.current === 'multi' ? MULTI_TIME_STEP : SINGLE_TIME_STEP;

    if (!gameStateRef.current || isPausedRef.current) {
      requestRef.current = requestAnimationFrame(update);
      return;
    }

    accumulatorRef.current += deltaTime;
    if (accumulatorRef.current > currentTimeStep * 4) accumulatorRef.current = currentTimeStep * 4;

    while (accumulatorRef.current >= currentTimeStep) {
      if (!gameStateRef.current.gameOver && !gameStateRef.current.gameWon) {
        if (gameModeRef.current === 'multi') {
          predictMultiplayerStep();
          if (gameStateRef.current) {
            updateVisualEffects(gameStateRef.current);
          }
        } else {
          simulateStep();
        }
      } else {
        updateVisualEffects(gameStateRef.current);
      }
      accumulatorRef.current -= currentTimeStep;
    }

    draw(gameStateRef.current, Date.now() - totalPausedTimeRef.current);
    requestRef.current = requestAnimationFrame(update);
  };

  const drawEntity = (ctx: CanvasRenderingContext2D, entity: Entity, now: number) => {
    ctx.save();
    ctx.translate(entity.pos.x, entity.pos.y);

    const isHit = now - entity.lastHitTime < 100;
    const isBlue = entity.team === Team.BLUE;
    const isBoss = entity.type === PieceType.KING && entity.team === Team.RED && !entity.id.startsWith('remote-') && entity.id !== 'player';
    const isNeutral = entity.team === Team.NEUTRAL;
    const isRemote = entity.id.startsWith('remote-');

    let baseColor = isHit ? '#ffffff' : (isNeutral ? '#d1d5db' : (isBlue ? (isRemote ? '#064e3b' : '#1e3a8a') : '#7f1d1d'));
    let topColor = isHit ? '#ffffff' : (isNeutral ? '#ffffff' : (isBlue ? (isRemote ? '#10b981' : '#3b82f6') : '#ef4444'));
    
    if (entity.color && entity.baseColor) {
      topColor = isHit ? '#ffffff' : entity.color;
      baseColor = isHit ? '#ffffff' : entity.baseColor;
    } else if (isBoss) {
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

    // Player Label
    const isLocalPlayer = entity.id === 'player';
    if (isLocalPlayer || isRemote) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      const label = entity.playerIndex !== undefined 
        ? `PLAYER ${entity.playerIndex + 1}${isLocalPlayer ? ' (YOU)' : ''}`
        : (isLocalPlayer ? 'YOU' : 'PLAYER');
      ctx.fillText(label, 0, -height - entity.radius - 5);
    }

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
    if (isNeutral) {
      ctx.fillStyle = '#9ca3af';
    } else if (entity.color) {
      ctx.fillStyle = entity.color;
    } else {
      ctx.fillStyle = isBlue ? '#22c55e' : (isBoss ? '#a855f7' : '#ef4444');
    }
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
    const targetCamX = Math.max(0, Math.min(Math.max(0, MAP_WIDTH - canvasSize.width), state.player.pos.x - canvasSize.width / 2));
    const targetCamY = Math.max(0, Math.min(Math.max(0, MAP_HEIGHT - canvasSize.height), state.player.pos.y - canvasSize.height / 2));
    const currentCam = cameraRef.current;
    const smoothing = gameModeRef.current === 'multi' ? 0.18 : 0.35;

    currentCam.x += (targetCamX - currentCam.x) * smoothing;
    currentCam.y += (targetCamY - currentCam.y) * smoothing;

    if (Math.abs(targetCamX - currentCam.x) < 0.5) currentCam.x = targetCamX;
    if (Math.abs(targetCamY - currentCam.y) < 0.5) currentCam.y = targetCamY;

    const camX = currentCam.x;
    const camY = currentCam.y;

    ctx.save();
    
    // Screen Shake
    if (state.screenShake > 0) {
      const dx = (Math.random() - 0.5) * state.screenShake;
      const dy = (Math.random() - 0.5) * state.screenShake;
      ctx.translate(dx, dy);
    }

    // Background (Ocean/Abyss outside map)
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

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
    const allEntities = [state.player, ...Object.values(state.remotePlayers), ...state.allies, ...state.enemies].sort((a, b) => a.pos.y - b.pos.y);
    allEntities.forEach(e => drawEntity(ctx, e, now));

    const effectEntities = [state.player, ...Object.values(state.remotePlayers), ...state.enemies];

    effectEntities.forEach(entity => {
      const isBoss = entity.type === PieceType.KING && entity.team === Team.RED;
      const isLocalPlayer = entity.id === 'player';

      if (now - entity.lastAttackTime < 180) {
        ctx.save();
        ctx.translate(entity.pos.x, entity.pos.y);
        ctx.rotate(entity.facingAngle);
        ctx.beginPath();
        ctx.arc(0, 0, entity.attackRange, -Math.PI / 3, Math.PI / 3);
        ctx.strokeStyle = isBoss ? 'rgba(239, 68, 68, 0.8)' : 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = isBoss ? 18 : 15;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      }

      if (now - entity.lastSkillTime < 550) {
        const progress = (now - entity.lastSkillTime) / 550;
        const alpha = Math.max(0, 1 - progress);
        ctx.beginPath();
        ctx.arc(entity.pos.x, entity.pos.y, (isBoss ? 320 : 300) * progress, 0, Math.PI * 2);
        ctx.strokeStyle = isBoss
          ? `rgba(239, 68, 68, ${alpha})`
          : `rgba(59, 130, 246, ${alpha})`;
        ctx.lineWidth = (isBoss ? 18 : 20) * alpha;
        ctx.stroke();
        ctx.fillStyle = isBoss
          ? `rgba(127, 29, 29, ${alpha * 0.18})`
          : `rgba(59, 130, 246, ${alpha * 0.3})`;
        ctx.fill();
      }
    });

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
    gameModeRef.current = gameMode;
  }, [gameMode]);

  useEffect(() => {
    roomCodeRef.current = multiState.roomCode;
  }, [multiState.roomCode]);

  useEffect(() => {
    // Check for room code in URL
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      pendingAutoJoinRef.current = roomFromUrl.toUpperCase();
      setJoinCode(roomFromUrl.toUpperCase());
      setGameMode('multi');
    }

    // Initialize Socket
    socketRef.current = io(socketUrl, {
      transports: ['websocket', 'polling'],
    });

    socketRef.current.on('connect', () => {
      setMultiState(prev => ({ ...prev, error: '' }));
      if (pendingAutoJoinRef.current) {
        socketRef.current?.emit('join-room', pendingAutoJoinRef.current);
        pendingAutoJoinRef.current = '';
      }
    });

    socketRef.current.on('connect_error', () => {
      setMultiState(prev => ({
        ...prev,
        error: socketUrl ? 'Realtime server unavailable' : 'Realtime server unavailable. Configure VITE_SOCKET_URL for deployment.'
      }));
    });

    socketRef.current.on('room-created', (code) => {
      roomCodeRef.current = code;
      setMultiState(prev => ({ ...prev, roomCode: code, isHost: true, status: 'lobby', error: '' }));
    });

    socketRef.current.on('room-joined', (code) => {
      roomCodeRef.current = code;
      setMultiState(prev => ({ ...prev, roomCode: code, isHost: false, status: 'lobby', error: '' }));
    });

    socketRef.current.on('room-update', (data) => {
      if (data.code) roomCodeRef.current = data.code;
      setMultiState(prev => ({
        ...prev,
        roomCode: data.code ?? prev.roomCode,
        players: data.players,
        isHost: data.hostId === socketRef.current?.id,
        status: data.status ?? prev.status,
        matchType: data.matchType ?? prev.matchType
      }));
    });

    socketRef.current.on('game-started', (data?: { roundId?: number }) => {
      roundIdRef.current = data?.roundId ?? roundIdRef.current + 1;
      clearTransientInputs();
      inputSeqRef.current = 0;
      pendingInputsRef.current = [];
      multiInputRef.current = {
        seq: 0,
        roundId: roundIdRef.current,
        clientTime: Date.now(),
        moveX: 0,
        moveY: 0,
        attack: false,
        skill: false,
      };
      setMultiState(prev => ({ ...prev, status: 'playing' }));
      setUiState({ score: 0, skillPercent: 0, gameOver: false, gameWon: false, allyCount: 0 });
      socketRef.current?.emit('player-input', {
        roomCode: roomCodeRef.current,
        input: multiInputRef.current
      });
      initGame('multi');
    });

    socketRef.current.on('game-state', (snapshot: MultiplayerSnapshot) => {
      applyMultiplayerSnapshot(snapshot);
    });

    socketRef.current.on('error-message', (msg) => {
      setMultiState(prev => ({ ...prev, error: msg }));
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    const updateSize = () => {
      const mobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || window.innerWidth < 1024;
      setIsMobile(mobile);
      if (mobile) {
        setCanvasSize({ width: window.innerWidth, height: window.innerHeight });
      } else {
        setCanvasSize({ width: 800, height: 600 });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);

    const emitKeyboardInput = () => {
      const moveX = (keysPressed.current.has('ArrowRight') || keysPressed.current.has('d') || keysPressed.current.has('D') ? 1 : 0)
        - (keysPressed.current.has('ArrowLeft') || keysPressed.current.has('a') || keysPressed.current.has('A') ? 1 : 0);
      const moveY = (keysPressed.current.has('ArrowDown') || keysPressed.current.has('s') || keysPressed.current.has('S') ? 1 : 0)
        - (keysPressed.current.has('ArrowUp') || keysPressed.current.has('w') || keysPressed.current.has('W') ? 1 : 0);
      const attack = keysPressed.current.has('z') || keysPressed.current.has('Z') || keysPressed.current.has('j') || keysPressed.current.has('J');
      const skill = keysPressed.current.has('x') || keysPressed.current.has('X') || keysPressed.current.has('k') || keysPressed.current.has('K');
      syncMultiInput({ moveX, moveY, attack, skill });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }
      if (e.key === 'Escape' || e.key.toLowerCase() === 'p') {
        togglePause();
      }
      keysPressed.current.add(e.key);
      emitKeyboardInput();
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressed.current.delete(e.key);
      emitKeyboardInput();
    };
    const handleBlur = () => {
      keysPressed.current.clear();
      syncMultiInput({ moveX: 0, moveY: 0, attack: false, skill: false });
    };

    window.addEventListener('keydown', handleKeyDown, { passive: false });
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    
    return () => {
      window.removeEventListener('resize', updateSize);
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

  const handleJoystickStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    setJoystick({ active: true, x: 0, y: 0, startX: touch.clientX, startY: touch.clientY });
  };

  const handleJoystickMove = (e: React.TouchEvent) => {
    if (!joystick.active) return;
    const touch = e.touches[0];
    const dx = touch.clientX - joystick.startX;
    const dy = touch.clientY - joystick.startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = 50;
    
    const limitedX = dist > maxDist ? (dx / dist) * maxDist : dx;
    const limitedY = dist > maxDist ? (dy / dist) * maxDist : dy;
    
    setJoystick(prev => ({ ...prev, x: limitedX, y: limitedY }));
    joystickRef.current = { x: limitedX / maxDist, y: limitedY / maxDist };
    syncMultiInput({ moveX: limitedX / maxDist, moveY: limitedY / maxDist });
  };

  const handleJoystickEnd = () => {
    setJoystick({ active: false, x: 0, y: 0, startX: 0, startY: 0 });
    joystickRef.current = { x: 0, y: 0 };
    syncMultiInput({ moveX: 0, moveY: 0 });
  };

  const triggerAttack = () => {
    keysPressed.current.add('z');
    syncMultiInput({ attack: true });
    if (attackReleaseTimeoutRef.current !== null) {
      window.clearTimeout(attackReleaseTimeoutRef.current);
    }
    attackReleaseTimeoutRef.current = window.setTimeout(() => {
      keysPressed.current.delete('z');
      syncMultiInput({ attack: false });
      attackReleaseTimeoutRef.current = null;
    }, 100);
  };

  const triggerSkill = () => {
    keysPressed.current.add('x');
    syncMultiInput({ skill: true });
    if (skillReleaseTimeoutRef.current !== null) {
      window.clearTimeout(skillReleaseTimeoutRef.current);
    }
    skillReleaseTimeoutRef.current = window.setTimeout(() => {
      keysPressed.current.delete('x');
      syncMultiInput({ skill: false });
      skillReleaseTimeoutRef.current = null;
    }, 100);
  };

  return (
    <div className={isMobile ? "fixed inset-0 bg-[#050505] text-white font-sans flex flex-col items-center justify-center select-none overflow-hidden" : "min-h-screen bg-[#050505] text-white font-sans flex flex-col items-center justify-center p-4 select-none"}>
      {/* Desktop Header */}
      {!isMobile && (
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
                <span className="text-[10px] uppercase text-zinc-500 font-black tracking-wider">MY ARMY</span>
                <span className="text-2xl font-black italic text-blue-500">{uiState.allyCount}</span>
              </div>
            </div>
            
            <div className="flex gap-2">
              <button 
                onClick={togglePause} 
                disabled={!isPlaying || uiState.gameOver || uiState.gameWon || gameMode === 'multi'}
                className="p-3 bg-zinc-900/80 rounded-2xl border-2 border-zinc-800 hover:bg-zinc-800 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={gameMode === 'multi' ? 'Pause unavailable in multiplayer' : 'Pause (P or Esc)'}
              >
                {isPaused ? <Play className="w-6 h-6" /> : <Pause className="w-6 h-6" />}
              </button>
              <button 
                onClick={() => {
                  if (gameMode === 'multi') {
                    leaveRoom();
                    return;
                  }
                  initGame('single');
                }} 
                className="p-3 bg-zinc-900/80 rounded-2xl border-2 border-zinc-800 hover:bg-red-900/50 hover:border-red-800 text-white transition-colors"
                title={gameMode === 'multi' ? 'Leave Room' : 'Restart'}
              >
                <RotateCcw className="w-6 h-6" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Game Canvas Container */}
      <div className={isMobile ? "relative w-full h-full flex items-center justify-center bg-black" : "relative border-8 border-zinc-900 rounded-3xl overflow-hidden shadow-[0_0_50px_rgba(220,38,38,0.15)]"}>
        {/* Mode Selection UI */}
        {!isPlaying && !uiState.gameOver && !uiState.gameWon && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-xl">
            {!gameMode ? (
              <div className="flex flex-col items-center gap-8 max-w-md w-full px-6">
                <motion.div 
                  initial={{ y: -20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  className="text-center"
                >
                  <h1 className="text-6xl font-black italic text-white tracking-tighter mb-2">SHOGI <span className="text-red-600 underline decoration-8 underline-offset-8">ABYSS</span></h1>
                  <p className="text-zinc-500 font-medium tracking-widest uppercase text-xs">Tactical Capture Combat</p>
                </motion.div>

                <div className="grid grid-cols-1 gap-4 w-full">
                  <button 
                    onClick={() => { setGameMode('single'); initGame('single'); }}
                    className="group relative flex items-center justify-between p-6 bg-zinc-900 border-2 border-zinc-800 rounded-3xl hover:border-blue-500 transition-all overflow-hidden"
                  >
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-blue-500/20 rounded-2xl group-hover:bg-blue-500/30 transition-colors">
                        <Play className="w-6 h-6 text-blue-500" />
                      </div>
                      <div className="text-left">
                        <h3 className="text-xl font-black text-white italic">SINGLE PLAYER</h3>
                        <p className="text-xs text-zinc-500 font-bold">Defeat the Red King alone</p>
                      </div>
                    </div>
                  </button>

                  <button 
                    onClick={() => setGameMode('multi')}
                    className="group relative flex items-center justify-between p-6 bg-zinc-900 border-2 border-zinc-800 rounded-3xl hover:border-red-500 transition-all overflow-hidden"
                  >
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-red-500/20 rounded-2xl group-hover:bg-red-500/30 transition-colors">
                        <Users className="w-6 h-6 text-red-500" />
                      </div>
                      <div className="text-left">
                        <h3 className="text-xl font-black text-white italic">MULTIPLAYER</h3>
                        <p className="text-xs text-zinc-500 font-bold">Compete with other Kings</p>
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            ) : gameMode === 'multi' && multiState.status === 'lobby' ? (
              <div className="flex flex-col items-center gap-8 max-w-md w-full px-6">
                <div className="text-center">
                  <h2 className="text-4xl font-black italic text-white tracking-tighter mb-2">MULTIPLAYER <span className="text-red-600">LOBBY</span></h2>
                  {multiState.roomCode && <p className="text-zinc-500 font-bold uppercase text-xs">Room: {multiState.roomCode}</p>}
                  <p className="text-zinc-600 font-bold uppercase text-[10px] mt-2 tracking-[0.3em]">Versus Mode</p>
                </div>

                {!multiState.roomCode ? (
                  <div className="grid grid-cols-1 gap-4 w-full">
                    <button 
                      onClick={createRoom}
                      className="flex items-center gap-4 p-6 bg-zinc-900 border-2 border-zinc-800 rounded-3xl hover:border-blue-500 transition-all"
                    >
                      <UserPlus className="w-6 h-6 text-blue-500" />
                      <div className="text-left">
                        <h3 className="text-xl font-black text-white italic">CREATE ROOM</h3>
                        <p className="text-xs text-zinc-500 font-bold">Start a versus battle</p>
                      </div>
                    </button>

                    <div className="flex flex-col gap-2">
                      <div className="relative">
                        <input 
                          type="text" 
                          placeholder="ENTER ROOM CODE OR INVITE LINK"
                          value={joinCode}
                          onChange={(e) => setJoinCode(e.target.value)}
                          className="w-full p-6 bg-zinc-900 border-2 border-zinc-800 rounded-3xl text-white font-black italic focus:border-red-500 outline-none transition-all placeholder:text-zinc-700"
                        />
                        <button 
                          onClick={joinRoom}
                          className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-red-600 rounded-2xl text-white hover:bg-red-500 transition-colors"
                        >
                          <LogIn className="w-6 h-6" />
                        </button>
                      </div>
                      {multiState.error && <p className="text-red-500 text-[10px] font-black uppercase text-center">{multiState.error}</p>}
                    </div>
                    
                    <button 
                      onClick={() => resetToMenu(false)}
                      className="w-full p-4 bg-zinc-900 border-2 border-zinc-800 rounded-2xl text-zinc-500 font-black italic hover:text-white transition-all mt-4"
                    >
                      BACK TO MENU
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-6 w-full">
                    <div className="w-full p-6 bg-zinc-900 border-2 border-zinc-800 rounded-3xl flex flex-col items-center gap-4">
                      <span className="text-zinc-500 font-black uppercase text-[10px] tracking-widest">Connected Players</span>
                      <div className="flex flex-wrap justify-center gap-2">
                        {multiState.players.map((p, idx) => (
                          <div key={p.id} className="flex items-center gap-2 px-4 py-2 bg-zinc-800 rounded-xl border border-zinc-700 text-white font-black italic text-sm">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
                            PLAYER {idx + 1} {p.id === socketRef.current?.id ? '(YOU)' : ''}
                          </div>
                        ))}
                      </div>                    </div>

                    <div className="flex gap-2 w-full">
                      <button 
                        onClick={copyRoomCode}
                        className="flex-1 flex items-center justify-center gap-2 p-4 bg-zinc-900 border-2 border-zinc-800 rounded-2xl text-zinc-400 font-black italic hover:text-white transition-all"
                      >
                        {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                        {copied ? 'COPIED!' : 'COPY CODE'}
                      </button>
                      
                      {multiState.isHost && (
                        <button 
                          onClick={startGameMulti}
                          disabled={multiState.players.length < 2}
                          className="flex-[2] p-4 bg-red-600 rounded-2xl text-white font-black italic hover:bg-red-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_30px_rgba(220,38,38,0.3)]"
                        >
                          START BATTLE
                        </button>
                      )}
                    </div>
                    
                    {!multiState.isHost && (
                      <p className="text-zinc-500 font-black italic animate-pulse">WAITING FOR HOST TO START...</p>
                    )}

                    <button 
                      onClick={leaveRoom}
                      className="w-full p-4 bg-zinc-900 border-2 border-zinc-800 rounded-2xl text-zinc-500 font-black italic hover:text-white transition-all mt-4"
                    >
                      LEAVE ROOM
                    </button>
                  </div>
                )}

                <button 
                  onClick={() => resetToMenu(Boolean(multiState.roomCode))}
                  className="text-zinc-600 font-black uppercase text-[10px] tracking-widest hover:text-zinc-400 transition-colors"
                >
                  BACK TO MENU
                </button>
              </div>
            ) : null}
          </div>
        )}

        <canvas
          ref={canvasRef}
          width={canvasSize.width}
          height={canvasSize.height}
          className={isMobile ? "w-full h-full block" : "bg-black block"}
          onClick={() => {
            if (!isPlaying && !uiState.gameOver && !uiState.gameWon && gameMode === 'single') initGame('single');
            if (!isMobile) window.focus();
          }}
        />

        {/* Mobile Controls Overlay */}
        {isMobile && isPlaying && !isPaused && (
          <div className="absolute inset-0 pointer-events-none">
            {/* Joystick Area */}
            <div 
              className="absolute bottom-6 left-2 w-36 h-36 flex items-center justify-center pointer-events-auto"
              onTouchStart={handleJoystickStart}
              onTouchMove={handleJoystickMove}
              onTouchEnd={handleJoystickEnd}
            >
              <div className="w-24 h-24 rounded-full bg-white/10 border-2 border-white/20 flex items-center justify-center backdrop-blur-sm">
                <div className="w-12 h-12 rounded-full bg-white/5 border border-white/10" />
                {joystick.active && (
                  <motion.div 
                    className="absolute w-12 h-12 rounded-full bg-white/40 shadow-[0_0_20px_rgba(255,255,255,0.3)] border border-white/50"
                    style={{ x: joystick.x, y: joystick.y }}
                  />
                )}
              </div>
            </div>

            {/* Action Buttons Area */}
            <div className="absolute bottom-6 right-6 w-48 h-48 pointer-events-auto">
              {/* Attack Button */}
              <div className="absolute bottom-0 right-0 flex flex-col items-center gap-1">
                <button 
                  className="w-20 h-20 rounded-full bg-red-600/70 border-2 border-red-400/50 flex items-center justify-center shadow-[0_0_30px_rgba(220,38,38,0.3)] active:scale-90 transition-transform backdrop-blur-sm"
                  onTouchStart={(e) => { e.preventDefault(); triggerAttack(); }}
                >
                  <Sword className="w-10 h-10 text-white" />
                </button>
                <span className="text-[8px] font-black italic text-red-500 tracking-widest drop-shadow-md">ATTACK</span>
              </div>

              {/* Skill Button */}
              <div className="absolute bottom-12 right-24 flex flex-col items-center gap-1">
                <button 
                  className="w-16 h-16 rounded-full bg-blue-600/60 border-2 border-blue-400/40 flex items-center justify-center shadow-lg active:scale-90 transition-transform backdrop-blur-sm relative overflow-hidden"
                  onTouchStart={(e) => { e.preventDefault(); triggerSkill(); }}
                >
                  <Zap className={`w-8 h-8 ${uiState.skillPercent >= 100 ? 'text-white fill-white animate-pulse' : 'text-blue-200/50'}`} />
                  <div 
                    className="absolute inset-0 bg-black/40 transition-all duration-100"
                    style={{ height: `${100 - uiState.skillPercent}%` }}
                  />
                </button>
                <span className="text-[8px] font-black italic text-blue-400 tracking-widest drop-shadow-md">DASH</span>
              </div>
            </div>
          </div>
        )}

        {/* UI HUD Overlay */}
        {isPlaying && (
          <div className="absolute top-6 left-6 right-6 flex justify-between items-start pointer-events-none">
            <div className="flex flex-col gap-2">
              <div className="flex flex-col">
                {gameMode === 'multi' && gameStateRef.current?.player && (
                  <div className="text-[10px] font-black italic text-white/60 tracking-widest uppercase -mb-1 ml-1">
                    {`${gameStateRef.current.player.team} SCORE`}
                  </div>
                )}
                <div className="text-4xl font-black italic tracking-tighter text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
                  {uiState.score.toLocaleString()}
                </div>
              </div>
              <div className="flex items-center gap-2 bg-blue-900/40 px-3 py-1 rounded-full border border-blue-500/30 backdrop-blur-md">
                <Skull className="w-4 h-4 text-blue-400" />
                <span className="text-xs font-black text-blue-100 uppercase tracking-widest">
                  {uiState.allyCount}
                </span>
              </div>
            </div>
            
            <button 
              onClick={togglePause}
              disabled={gameMode === 'multi'}
              className="p-4 bg-white/10 hover:bg-white/20 rounded-2xl border border-white/20 backdrop-blur-md pointer-events-auto transition-colors shadow-xl"
            >
              {isPaused ? <Play className="w-6 h-6 fill-white" /> : <Pause className="w-6 h-6 fill-white" />}
            </button>
          </div>
        )}

        {/* Desktop HUD (Attack/Dash Indicators) */}
        {!isMobile && isPlaying && (
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

      {/* Desktop Controls Help */}
      {!isMobile && (
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
      )}

      {/* Overlays (Start, Game Over, Pause) */}
      <AnimatePresence>
        {isPaused && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/60 backdrop-blur-md"
          >
            <div className="bg-zinc-900/90 p-12 rounded-[40px] border border-white/10 shadow-2xl flex flex-col items-center gap-8">
              <h2 className="text-6xl font-black italic tracking-tighter text-white">PAUSED</h2>
              <button
                onClick={togglePause}
                className="px-12 py-5 bg-white text-black rounded-full font-black italic text-xl hover:scale-105 transition-transform"
              >
                RESUME MISSION
              </button>
              <button 
                onClick={() => resetToMenu(gameMode === 'multi')}
                className="w-full py-4 bg-zinc-900 border-2 border-zinc-800 rounded-2xl text-zinc-500 font-black italic hover:text-white transition-all mt-4"
              >
                QUIT TO MENU
              </button>
            </div>
          </motion.div>
        )}

        {(uiState.gameOver || uiState.gameWon) && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/95 backdrop-blur-2xl p-8 text-center"
          >
            <motion.div
              initial={{ scale: 0.5, y: 50 }} animate={{ scale: 1, y: 0 }}
              className="flex flex-col items-center"
            >
              {uiState.gameWon ? (
                <div className="mb-8">
                  <div className="w-32 h-32 bg-yellow-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-[0_0_60px_rgba(234,179,8,0.4)]">
                    <Trophy className="w-16 h-16 text-black" />
                  </div>
                  <h2 className="text-8xl font-black italic tracking-tighter text-yellow-500 leading-none">VICTORY</h2>
                  <p className="text-yellow-500/60 uppercase tracking-[0.4em] font-bold mt-2">Zone Secured</p>
                </div>
              ) : (
                <div className="mb-8">
                  <div className="w-32 h-32 bg-red-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-[0_0_60px_rgba(220,38,38,0.4)]">
                    <Skull className="w-16 h-16 text-white" />
                  </div>
                  <h2 className="text-8xl font-black italic tracking-tighter text-red-600 leading-none">DEFEATED</h2>
                  <p className="text-red-600/60 uppercase tracking-[0.4em] font-bold mt-2">Signal Lost</p>
                </div>
              )}
              
      <div className="flex flex-col gap-4 w-full max-w-2xl mb-12">
                {gameMode === 'multi' && (multiState.status === 'playing' || uiState.gameOver || uiState.gameWon) ? (
                  multiState.players.map((p, idx) => {
                    const isLocal = p.id === socketRef.current?.id;
                    const playerScore = multiScores[p.id] || 0;
                    return (
                      <div key={p.id} className={`flex items-center justify-between p-6 rounded-2xl border ${isLocal ? 'bg-blue-500/10 border-blue-500/30' : 'bg-white/5 border-white/10'}`}>
                        <div className="flex items-center gap-4">
                          <div className="w-4 h-4 rounded-full" style={{ backgroundColor: p.color }} />
                          <span className="text-xl font-black italic text-white uppercase tracking-tight">
                            PLAYER {idx + 1} {isLocal ? '(YOU)' : ''}
                          </span>
                        </div>
                        <div className="text-3xl font-black italic text-white">
                          {playerScore.toLocaleString()}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="bg-white/5 backdrop-blur-md border border-white/10 p-8 rounded-[32px] min-w-[300px] flex flex-col items-center">
                    <div className="text-zinc-500 text-xs uppercase tracking-widest font-bold mb-1">Final Score</div>
                    <div className="text-6xl font-black italic text-white tracking-tighter">
                      {uiState.score.toLocaleString()}
                    </div>
                  </div>
                )}
              </div>

              {gameMode === 'multi' ? (
                <div className="flex flex-col gap-4 w-full max-w-sm">
                  {multiState.isHost && (
                    <button
                      onClick={retryGameMulti}
                      className="flex items-center justify-center gap-4 px-12 py-6 bg-white text-black rounded-full font-black italic text-2xl hover:scale-105 transition-transform shadow-xl"
                    >
                      <RotateCcw className="w-8 h-8" />
                      RETRY
                    </button>
                  )}
                  <button
                    onClick={leaveRoom}
                    className="flex items-center justify-center gap-4 px-12 py-6 bg-zinc-800 text-white rounded-full font-black italic text-2xl hover:scale-105 transition-transform shadow-xl"
                  >
                    <LogOut className="w-8 h-8" />
                    LEAVE ROOM
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => initGame('single')}
                  className="flex items-center gap-4 px-12 py-6 bg-white text-black rounded-full font-black italic text-2xl hover:scale-105 transition-transform shadow-xl"
                >
                  <RotateCcw className="w-8 h-8" />
                  RESTART
                </button>
              )}
              <button 
                onClick={() => resetToMenu(gameMode === 'multi')}
                className="w-full py-4 bg-zinc-900 border-2 border-zinc-800 rounded-2xl text-zinc-500 font-black italic hover:text-white transition-all mt-4"
              >
                BACK TO MENU
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
