// Física do jogador em primeira pessoa.
// - Paredes e móveis: cápsula testada contra a malha de colisão (three-mesh-bvh), empurrando só na horizontal,
//   assim o jogador desliza nas paredes.
// - Chão, degraus e gravidade: raios para baixo a partir da altura do degrau. Se o chão logo à frente estiver
//   até "alturaDegrau" acima do pé, o jogador sobe; se for mais alto, a cápsula bloqueia.
import * as THREE from 'three';

const PASSOS = 5; // subpassos por quadro, evita atravessar paredes finas em quadros lentos

const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _triPt = new THREE.Vector3();
const _capPt = new THREE.Vector3();
const _push = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _ray = new THREE.Ray();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _UP = new THREE.Vector3(0, 1, 0);

export class Jogador {
  constructor(camera, cfg) {
    this.camera = camera;
    this.cfg = cfg;
    this.pos = new THREE.Vector3();   // posição dos PÉS
    this.vel = new THREE.Vector3();
    this.noChao = false;
    this.voo = false;
    this.collider = null;             // THREE.Mesh com geometry.boundsTree
    this.camY = 0;
  }

  teleportar(x, y, z, yawGraus) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.noChao = false;
    if (yawGraus !== undefined) this.camera.rotation.set(0, THREE.MathUtils.degToRad(yawGraus), 0, 'YXZ');
    this.camY = y + this.cfg.alturaOlhos;
    this._acharChao(2.0);
    this.camY = this.pos.y + this.cfg.alturaOlhos;
    this._posicionarCamera(1);
  }

  yawGraus() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    return THREE.MathUtils.radToDeg(e.y);
  }

  // entrada: { frente, lado, correr, pular, subir }  (frente/lado/subir em -1..1)
  update(dt, entrada) {
    dt = Math.min(dt, 0.05);
    const c = this.cfg;
    this.camera.getWorldDirection(_fwd);
    const dirVoo = _fwd.clone();
    _fwd.y = 0; _fwd.normalize();
    _right.crossVectors(_fwd, _UP).normalize();
    const vel = c.velocidade * (entrada.correr ? c.multCorrida : 1);

    if (this.voo) {
      _wish.set(0, 0, 0).addScaledVector(dirVoo, entrada.frente).addScaledVector(_right, entrada.lado);
      if (_wish.lengthSq() > 1) _wish.normalize();
      _wish.multiplyScalar(vel * 1.5);
      _wish.y += entrada.subir * vel;
      this.pos.addScaledVector(_wish, dt);
      this.vel.set(0, 0, 0);
      this.camY = this.pos.y + c.alturaOlhos;
      this._posicionarCamera(1);
      return;
    }

    _wish.set(0, 0, 0).addScaledVector(_fwd, entrada.frente).addScaledVector(_right, entrada.lado);
    if (_wish.lengthSq() > 1) _wish.normalize();
    _wish.multiplyScalar(vel);

    if (entrada.pular && this.noChao) { this.vel.y = c.forcaPulo; this.noChao = false; }

    const h = dt / PASSOS;
    for (let i = 0; i < PASSOS; i++) {
      this.vel.x = _wish.x; this.vel.z = _wish.z;
      if (!this.noChao) this.vel.y -= c.gravidade * h;
      this.pos.x += this.vel.x * h;
      this.pos.z += this.vel.z * h;
      this._resolverParedes();
      this.pos.y += this.vel.y * h;
      this._resolverTeto();
      this._resolverChao();
    }

    if (this.pos.y < -10) this.onCaiu?.();

    // suaviza a câmera ao subir degraus
    const alvo = this.pos.y + c.alturaOlhos;
    this.camY = this.noChao ? THREE.MathUtils.lerp(this.camY, alvo, Math.min(1, dt * 18)) : alvo;
    if (Math.abs(this.camY - alvo) > 0.4) this.camY = alvo;
    this._posicionarCamera();
  }

  _posicionarCamera() {
    this.camera.position.set(this.pos.x, this.camY, this.pos.z);
  }

  _resolverParedes() {
    if (!this.collider) return;
    const c = this.cfg, r = c.raio;
    const bvh = this.collider.geometry.boundsTree;
    const y0 = this.pos.y + c.alturaDegrau + r;
    const y1 = Math.max(y0, this.pos.y + c.alturaCorpo - r);
    _seg.start.set(this.pos.x, y0, this.pos.z);
    _seg.end.set(this.pos.x, y1, this.pos.z);
    for (let it = 0; it < 2; it++) {
      _box.makeEmpty().expandByPoint(_seg.start).expandByPoint(_seg.end);
      _box.min.addScalar(-r); _box.max.addScalar(r);
      let mexeu = false;
      bvh.shapecast({
        intersectsBounds: b => b.intersectsBox(_box),
        intersectsTriangle: tri => {
          const d = tri.closestPointToSegment(_seg, _triPt, _capPt);
          if (d >= r) return;
          // só empurra na horizontal: chão e teto são tratados pelos raios
          if (d > 1e-5) _push.subVectors(_capPt, _triPt).divideScalar(d);
          else tri.getNormal(_push);          // segmento encostado no triângulo: usa a normal
          const horiz = Math.hypot(_push.x, _push.z);
          if (horiz < 0.3) return;            // contato quase vertical (tampo, assento): não bloqueia
          _push.y = 0;
          _push.multiplyScalar(Math.min(r, (r - d) / horiz) / horiz);
          _seg.start.add(_push); _seg.end.add(_push);
          mexeu = true;
        },
      });
      if (!mexeu) break;
    }
    this.pos.x = _seg.start.x;
    this.pos.z = _seg.start.z;
  }

  _maiorChao(alturaOrigem, alcance) {
    const bvh = this.collider.geometry.boundsTree;
    const o = this.cfg.raio * 0.6;
    const offs = [[0, 0], [o, 0], [-o, 0], [0, o], [0, -o]];
    let melhor = null;
    for (const [dx, dz] of offs) {
      _ray.origin.set(this.pos.x + dx, alturaOrigem, this.pos.z + dz);
      _ray.direction.copy(_down);
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, alcance);
      if (hit && (melhor === null || hit.point.y > melhor)) melhor = hit.point.y;
    }
    return melhor;
  }

  _acharChao(alcance) {
    if (!this.collider) return;
    const topo = this.pos.y + this.cfg.alturaDegrau + 0.05;
    const chao = this._maiorChao(topo, alcance);
    if (chao !== null) { this.pos.y = chao; this.noChao = true; }
  }

  _resolverChao() {
    if (!this.collider) { this.noChao = false; return; }
    const c = this.cfg;
    const topo = this.pos.y + c.alturaDegrau + 0.05;
    const encaixe = this.noChao ? 0.3 : 0.0;   // ao andar, "gruda" no chão descendo degraus
    const chao = this._maiorChao(topo, c.alturaDegrau + 0.05 + 0.35);
    if (chao !== null && this.vel.y <= 0 && this.pos.y - chao <= encaixe + 1e-3) {
      this.pos.y = chao; this.vel.y = 0; this.noChao = true;
    } else {
      this.noChao = false;
    }
  }

  _resolverTeto() {
    if (!this.collider || this.vel.y <= 0) return;
    const c = this.cfg;
    const bvh = this.collider.geometry.boundsTree;
    _ray.origin.set(this.pos.x, this.pos.y + c.alturaDegrau + 0.05, this.pos.z);
    _ray.direction.copy(_up);
    const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, c.alturaCorpo);
    if (hit && hit.point.y < this.pos.y + c.alturaCorpo) {
      this.pos.y = hit.point.y - c.alturaCorpo;
      this.vel.y = 0;
    }
  }
}
