import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { MeshBVH } from 'three-mesh-bvh';
import { CONFIG_PADRAO } from './config.js';
import { Jogador } from './jogador.js';
import { EH_TOQUE, criarControlesToque, pedirTelaCheia } from './toque.js';

const PARAMS = new URLSearchParams(location.search);
// versão única, pensada para celular (texturas 2048 px comprimidas para a GPU)
const VERSAO_LEVE = true;
const ARQ_CASA = 'assets/apartamento.glb';
const ARQ_COLISAO = 'assets/colisao.glb';
const TAMANHO_APTO = 4.3e6, TAMANHO_COLISAO = 6.4e5;  // só para a barra de progresso
const ARQ_MINIMAPA = 'assets/minimapa.jpg';
// área (em metros, escala 1) coberta pela imagem do minimapa
const MINIMAPA = { x0: -4.3, x1: 4.0, z0: -9.1, z1: 9.1 };
const ALTURA_CORTE_SOMBRA = 2.6; // acima disso (forro) a malha não projeta sombra na "luz dinâmica"
const CHAVE_SALVA = 'apto-sf-config-v2';
const MODO_TESTE = PARAMS.has('teste');

// ---------- configuração (padrão + o que foi salvo neste navegador) ----------
const cfg = structuredClone(CONFIG_PADRAO);
try {
  const salvo = JSON.parse(localStorage.getItem(CHAVE_SALVA) || 'null');
  if (salvo) Object.assign(cfg, salvo, { spawn: { ...cfg.spawn, ...(salvo.spawn || {}) } });
  else if (EH_TOQUE) cfg.sombras = false;   // no celular, sombras desligadas por padrão (mais leve)
} catch { /* sem localStorage: usa o padrão */ }
function salvar() { try { localStorage.setItem(CHAVE_SALVA, JSON.stringify(cfg)); } catch { /* ignora */ } }

// ---------- elementos da página ----------
const $ = id => document.getElementById(id);
const telaCarregando = $('carregando'), telaInicio = $('inicio'), telaErro = $('erro');
const barra = $('barra-progresso'), textoProgresso = $('texto-progresso');
const divFps = $('fps'), divModo = $('modo'), divAviso = $('aviso'), canvasMapa = $('minimapa');

// ---------- renderizador, cena, câmera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, EH_TOQUE ? 1.5 : 2));
if (EH_TOQUE) document.body.classList.add('toque');
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b0e);   // o que aparece pelas portas que dão para cômodos não escaneados

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 80);
camera.rotation.order = 'YXZ';

const casa = new THREE.Group();          // malha visual (recebe a escala)
scene.add(casa);

// luzes da "luz dinâmica"
const hemi = new THREE.HemisphereLight(0xffffff, 0xd6cdbf, cfg.intensidadeHemisferica);
const sol = new THREE.DirectionalLight(0xfff4e5, cfg.intensidadeDirecional);
sol.position.set(-3, 12, -2);
sol.target.position.set(0, 0, 0);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
Object.assign(sol.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 0.5, far: 30 });
sol.shadow.bias = -0.0005;
sol.shadow.normalBias = 0.03;
scene.add(hemi, sol, sol.target);

// ---------- jogador e controles ----------
const jogador = new Jogador(camera, cfg);
const controles = new PointerLockControls(camera, document.body);
jogador.onCaiu = () => irParaSpawn();

const teclas = new Set();
let pedidoPulo = false;
let colliderVisivel = false;
let mostrarFps = false, mostrarMapa = true;

// ---------- carregamento ----------
const ktx2 = new KTX2Loader().setTranscoderPath('vendor/three/examples/jsm/libs/basis/').detectSupport(renderer);
const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
const progresso = { [ARQ_CASA]: [0, TAMANHO_APTO], [ARQ_COLISAO]: [0, TAMANHO_COLISAO] };
function atualizarProgresso() {
  let a = 0, t = 0;
  for (const [l, tot] of Object.values(progresso)) { a += l; t += tot; }
  const p = Math.min(100, Math.round((a / t) * 100));
  barra.style.width = p + '%';
  textoProgresso.textContent = p < 100 ? `Baixando o apartamento… ${p}%` : 'Preparando texturas…';
}
function carregar(url) {
  return new Promise((ok, falha) => loader.load(url, ok, e => {
    progresso[url] = [e.loaded, e.total || progresso[url][1]];
    atualizarProgresso();
  }, falha));
}

let materiais = [];      // { mesh, original, dinamica }
let baseColisao = null;  // geometria de colisão em escala 1
let collider = null;

function montarCasa(gltf) {
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    const map = o.material.map;
    const original = new THREE.MeshBasicMaterial({ map });
    const dinamica = new THREE.MeshStandardMaterial({ map, roughness: 0.9, metalness: 0 });
    // o forro não projeta sombra (senão a luz, que vem "de cima", deixaria a casa toda na sombra)
    const prof = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    prof.onBeforeCompile = sh => {
      sh.uniforms.corteY = { get value() { return ALTURA_CORTE_SOMBRA * cfg.escala; } };
      sh.vertexShader = 'varying float vMundoY;\n' + sh.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\nvMundoY = (modelMatrix * vec4(transformed, 1.0)).y;');
      sh.fragmentShader = 'uniform float corteY;\nvarying float vMundoY;\n' + sh.fragmentShader.replace('void main() {',
        'void main() {\n if (vMundoY > corteY) discard;');
    };
    o.customDepthMaterial = prof;
    o.castShadow = o.receiveShadow = true;
    materiais.push({ mesh: o, original, dinamica });
  });
  casa.add(gltf.scene);
}

function montarColisao(gltf) {
  const geos = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    // o arquivo vem quantizado (inteiros de 16 bits); converte para float antes de aplicar a transformação
    const p = o.geometry.attributes.position, arr = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { arr[i * 3] = p.getX(i); arr[i * 3 + 1] = p.getY(i); arr[i * 3 + 2] = p.getZ(i); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.setIndex(o.geometry.index);
    geos.push(g.applyMatrix4(o.matrixWorld));
  });
  baseColisao = geos[0];
  const mat = new THREE.MeshBasicMaterial({ color: 0x33ff88, wireframe: true, transparent: true, opacity: 0.45, depthTest: true });
  collider = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  collider.visible = colliderVisivel;
  scene.add(collider);
  aplicarEscala();
}

function aplicarEscala() {
  casa.scale.setScalar(cfg.escala);
  if (!baseColisao) return;
  const g = baseColisao.clone();
  g.scale(cfg.escala, cfg.escala, cfg.escala);
  g.boundsTree = new MeshBVH(g);
  collider.geometry.dispose();
  collider.geometry = g;
  jogador.collider = collider;
}

// ---------- luz ----------
const TONE = { ACESFilmic: THREE.ACESFilmicToneMapping, AgX: THREE.AgXToneMapping, Neutral: THREE.NeutralToneMapping, Nenhum: THREE.NoToneMapping };
function aplicarLuz() {
  const din = cfg.modoLuz === 'dinamica';
  for (const m of materiais) { m.mesh.material = din ? m.dinamica : m.original; m.mesh.material.needsUpdate = true; }
  hemi.visible = din; sol.visible = din;
  hemi.intensity = cfg.intensidadeHemisferica;
  sol.intensity = cfg.intensidadeDirecional;
  sol.castShadow = cfg.sombras;
  renderer.shadowMap.enabled = din && cfg.sombras;
  renderer.toneMapping = TONE[cfg.toneMapping] ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = din ? cfg.exposicaoDinamica : cfg.exposicaoOriginal;
  materiais.forEach(m => { m.original.needsUpdate = true; m.dinamica.needsUpdate = true; });
}

// ---------- spawn / posição ----------
function irParaSpawn() {
  const s = cfg.spawn;
  jogador.teleportar(s.x * cfg.escala, s.y * cfg.escala, s.z * cfg.escala, cfg.rotacaoInicial);
}
function textoPosicao() {
  const p = jogador.pos, e = cfg.escala;
  return `x=${(p.x / e).toFixed(2)}  y=${(p.y / e).toFixed(2)}  z=${(p.z / e).toFixed(2)}  rotação=${jogador.yawGraus().toFixed(0)}°`;
}
let timerAviso = 0;
function aviso(txt, ms = 3500) {
  divAviso.textContent = txt; divAviso.classList.remove('escondido');
  clearTimeout(timerAviso); timerAviso = setTimeout(() => divAviso.classList.add('escondido'), ms);
}

// ---------- painel de ajustes (aparece no ESC) ----------
const gui = new GUI({ title: 'Ajustes (depuração)' });
gui.hide();
gui.onChange(salvar);
const fModelo = gui.addFolder('Modelo');
fModelo.add(cfg, 'escala', 0.5, 2, 0.01).name('Escala').onFinishChange(() => { aplicarEscala(); irParaSpawn(); });
const fJog = gui.addFolder('Jogador');
fJog.add(cfg, 'alturaOlhos', 1.0, 2.0, 0.01).name('Altura dos olhos (m)').onChange(() => { jogador.camY = jogador.pos.y + cfg.alturaOlhos; });
fJog.add(cfg, 'alturaCorpo', 1.2, 2.0, 0.01).name('Altura do corpo (m)');
fJog.add(cfg, 'raio', 0.12, 0.4, 0.01).name('Raio (m)');
fJog.add(cfg, 'alturaDegrau', 0, 0.4, 0.01).name('Degrau máx. (m)');
fJog.add(cfg, 'velocidade', 0.5, 6, 0.1).name('Velocidade (m/s)');
fJog.add(cfg, 'forcaPulo', 0, 6, 0.1).name('Pulo');
const fSpawn = gui.addFolder('Nascimento');
fSpawn.add(cfg.spawn, 'x', -8, 8, 0.01);
fSpawn.add(cfg.spawn, 'y', -1, 3, 0.01);
fSpawn.add(cfg.spawn, 'z', -8, 8, 0.01);
fSpawn.add(cfg, 'rotacaoInicial', -180, 180, 1).name('Rotação inicial (°)');
const acoes = {
  usarAtual() {
    const e = cfg.escala;
    Object.assign(cfg.spawn, { x: +(jogador.pos.x / e).toFixed(2), y: +(jogador.pos.y / e).toFixed(2), z: +(jogador.pos.z / e).toFixed(2) });
    cfg.rotacaoInicial = Math.round(jogador.yawGraus());
    gui.controllersRecursive().forEach(c => c.updateDisplay()); salvar();
    aviso('Nascimento = posição atual');
  },
  irSpawn() { irParaSpawn(); },
  async copiar() {
    const txt = 'export const CONFIG_PADRAO = ' + JSON.stringify(cfg, null, 2) + ';';
    console.log(txt);
    try { await navigator.clipboard.writeText(txt); aviso('Configuração copiada (cole em js/config.js)'); }
    catch { aviso('Não deu para copiar; a configuração foi impressa no console (F12)'); }
  },
  restaurar() {
    try { localStorage.removeItem(CHAVE_SALVA); } catch { /* ignora */ }
    Object.assign(cfg, structuredClone(CONFIG_PADRAO));
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    aplicarEscala(); aplicarLuz(); irParaSpawn();
  },
};
fSpawn.add(acoes, 'usarAtual').name('Usar posição atual');
fSpawn.add(acoes, 'irSpawn').name('Ir para o nascimento');
const fLuz = gui.addFolder('Luz');
fLuz.add(cfg, 'modoLuz', { 'Original do escaneamento': 'original', 'Dinâmica': 'dinamica' }).name('Modo').onChange(aplicarLuz);
fLuz.add(cfg, 'toneMapping', Object.keys(TONE)).name('Tone mapping').onChange(aplicarLuz);
fLuz.add(cfg, 'exposicaoOriginal', 0.3, 3, 0.05).name('Exposição (original)').onChange(aplicarLuz);
fLuz.add(cfg, 'exposicaoDinamica', 0.3, 3, 0.05).name('Exposição (dinâmica)').onChange(aplicarLuz);
fLuz.add(cfg, 'intensidadeHemisferica', 0, 4, 0.05).name('Luz ambiente').onChange(aplicarLuz);
fLuz.add(cfg, 'intensidadeDirecional', 0, 4, 0.05).name('Luz direcional').onChange(aplicarLuz);
fLuz.add(cfg, 'sombras').name('Sombras').onChange(aplicarLuz);
// mesmas ações das teclas, para quem está no celular
const depuracao = {
  colisao() {
    colliderVisivel = !colliderVisivel; if (collider) collider.visible = colliderVisivel;
    aviso(colliderVisivel ? 'Malha de colisão: visível' : 'Malha de colisão: oculta');
  },
  voo() {
    jogador.voo = !jogador.voo;
    if (!jogador.voo) { jogador.vel.set(0, 0, 0); jogador.noChao = false; }
    aviso(jogador.voo ? 'Modo voo LIGADO (sem colisão)' : 'Modo voo desligado');
  },
  posicao() { const t = textoPosicao(); console.log('Posição:', t); aviso(t, 6000); },
  fps() { mostrarFps = !mostrarFps; divFps.classList.toggle('escondido', !mostrarFps); },
  minimapa() { mostrarMapa = !mostrarMapa; canvasMapa.classList.toggle('escondido', !mostrarMapa); },
};
const fDep = gui.addFolder('Depuração');
fDep.add(depuracao, 'colisao').name('Mostrar/ocultar colisão (V)');
fDep.add(depuracao, 'voo').name('Modo voo liga/desliga (N)');
fDep.add(depuracao, 'posicao').name('Mostrar posição (P)');
fDep.add(depuracao, 'fps').name('FPS (F)');
fDep.add(depuracao, 'minimapa').name('Minimapa (M)');
fDep.close();
gui.add(acoes, 'copiar').name('Copiar configuração');
gui.add(acoes, 'restaurar').name('Restaurar padrão');
fJog.close(); fSpawn.close(); fModelo.close();

// ---------- teclado ----------
addEventListener('keydown', e => {
  if (e.repeat) { teclas.add(e.code); return; }
  teclas.add(e.code);
  if (!jogando()) return;
  switch (e.code) {
    case 'Space': pedidoPulo = true; e.preventDefault(); break;
    case 'KeyV': depuracao.colisao(); break;
    case 'KeyN': depuracao.voo(); break;
    case 'KeyP': depuracao.posicao(); break;
    case 'KeyF': depuracao.fps(); break;
    case 'KeyM': depuracao.minimapa(); break;
    case 'KeyR': irParaSpawn(); break;
  }
});
addEventListener('keyup', e => teclas.delete(e.code));
addEventListener('blur', () => teclas.clear());

function jogando() { return controles.isLocked || MODO_TESTE || toque.estado.ativo; }
function eixo(pos, neg) { return (pos.some(k => teclas.has(k)) ? 1 : 0) - (neg.some(k => teclas.has(k)) ? 1 : 0); }

// ---------- telas ----------
const toque = criarControlesToque(camera, { onPular: () => { pedidoPulo = true; }, onMenu: pausarToque });
function pausarToque() {
  toque.desligar();
  $('botao-entrar').textContent = 'Toque para continuar';
  telaInicio.classList.add('pausa');
  telaInicio.classList.remove('escondido'); gui.show();
}
$('botao-entrar').addEventListener('click', () => {
  if (EH_TOQUE) {
    pedirTelaCheia();
    telaInicio.classList.add('escondido'); gui.hide();
    toque.ligar();
  } else {
    controles.lock();
  }
});
if (EH_TOQUE) { gui.close(); $('botao-entrar').textContent = 'Toque para entrar'; }
controles.addEventListener('lock', () => { telaInicio.classList.add('escondido'); gui.hide(); });
controles.addEventListener('unlock', () => {
  teclas.clear();
  $('botao-entrar').textContent = 'Clique para continuar';
  telaInicio.classList.add('pausa');   // fundo mais transparente para ver o efeito dos ajustes
  telaInicio.classList.remove('escondido'); gui.show();
});

// ---------- minimapa ----------
const ctxMapa = canvasMapa.getContext('2d');
const imgMapa = new Image();
imgMapa.onload = () => { canvasMapa.width = imgMapa.width; canvasMapa.height = imgMapa.height; };
imgMapa.onerror = () => { mostrarMapa = false; canvasMapa.classList.add('escondido'); };
imgMapa.src = ARQ_MINIMAPA;
function desenharMapa() {
  if (!mostrarMapa || !imgMapa.complete || !imgMapa.naturalWidth) return;
  const W = canvasMapa.width, H = canvasMapa.height;
  ctxMapa.drawImage(imgMapa, 0, 0);
  const e = cfg.escala;
  const px = ((jogador.pos.x / e) - MINIMAPA.x0) / (MINIMAPA.x1 - MINIMAPA.x0) * W;
  const pz = ((jogador.pos.z / e) - MINIMAPA.z0) / (MINIMAPA.z1 - MINIMAPA.z0) * H;
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const ang = Math.atan2(dir.z, dir.x);
  const s = W / 60;
  ctxMapa.save(); ctxMapa.translate(px, pz); ctxMapa.rotate(ang);
  ctxMapa.fillStyle = 'rgba(233,180,76,.35)';
  ctxMapa.beginPath(); ctxMapa.moveTo(0, 0); ctxMapa.arc(0, 0, s * 4, -0.6, 0.6); ctxMapa.closePath(); ctxMapa.fill();
  ctxMapa.fillStyle = '#e9b44c'; ctxMapa.strokeStyle = '#000'; ctxMapa.lineWidth = s * 0.25;
  ctxMapa.beginPath(); ctxMapa.arc(0, 0, s * 0.9, 0, Math.PI * 2); ctxMapa.fill(); ctxMapa.stroke();
  ctxMapa.restore();
}

// ---------- laço principal ----------
const relogio = new THREE.Timer();
let quadros = 0, tFps = 0, tMapa = 0;
function quadro(tempo) {
  relogio.update(tempo);
  const dt = relogio.getDelta();
  if (jogando()) {
    jogador.update(dt, {
      frente: THREE.MathUtils.clamp(eixo(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']) + toque.estado.frente, -1, 1),
      lado: THREE.MathUtils.clamp(eixo(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']) + toque.estado.lado, -1, 1),
      correr: teclas.has('ShiftLeft') || teclas.has('ShiftRight') || toque.estado.correr,
      pular: pedidoPulo,
      subir: eixo(['Space', 'KeyE'], ['KeyC', 'ControlLeft', 'KeyQ']),
    });
  }
  pedidoPulo = false;
  divModo.classList.toggle('escondido', !jogador.voo);
  divModo.textContent = 'MODO VOO';
  renderer.render(scene, camera);

  quadros++; tFps += dt; tMapa += dt;
  if (tFps >= 0.5) {
    if (mostrarFps) divFps.textContent = `${Math.round(quadros / tFps)} FPS · ${renderer.info.render.triangles.toLocaleString('pt-BR')} triângulos`;
    quadros = 0; tFps = 0;
  }
  if (tMapa > 0.1) { desenharMapa(); tMapa = 0; }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- início ----------
try {
  const [gCasa, gCol] = await Promise.all([carregar(ARQ_CASA), carregar(ARQ_COLISAO)]);
  montarCasa(gCasa);
  montarColisao(gCol);
  aplicarLuz();
  irParaSpawn();
  await renderer.compileAsync(scene, camera);
  telaCarregando.classList.add('escondido');
  if (!MODO_TESTE) telaInicio.classList.remove('escondido');
  canvasMapa.classList.toggle('escondido', !mostrarMapa);
  renderer.setAnimationLoop(quadro);
} catch (err) {
  console.error(err);
  telaCarregando.classList.add('escondido');
  telaErro.classList.remove('escondido');
  telaErro.textContent = 'Não foi possível carregar o apartamento.\n\n' + (err?.message || err) +
    (location.protocol === 'file:' ? '\n\nAbra pelo servidor local (veja o README), não clicando direto no arquivo .html.' : '');
}

// acesso para testes automáticos e para o console (F12)
window.jogo = { THREE, toque, VERSAO_LEVE, cfg, jogador, camera, renderer, scene, teclas, aplicarLuz, aplicarEscala, irParaSpawn, textoPosicao,
  get collider() { return collider; }, setPulo() { pedidoPulo = true; } };
