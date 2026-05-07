/**
 * system3d.js — Mô Hình 3D Hệ Thống AutoFertilizer
 * Hiển thị: Bồn N/P/K, Động cơ bước, Cảm biến lưu lượng,
 *           Van điện từ, Bơm, Bồn pha trộn
 * Animation được điều khiển theo trạng thái thực tế từ socket.io
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── State ─────────────────────────────────────────────
let scene, camera, renderer, controls;
const C = {}; // components map
let clock = new THREE.Clock();
let t = 0;
let _inited = false;

// System state - updated by socket.io
export const state = {
    N: { active: false, flow: 0, pct: 0, steps: 0 },
    P: { active: false, flow: 0, pct: 0, steps: 0 },
    K: { active: false, flow: 0, pct: 0, steps: 0 },
    pump: false, running: false
};

const COL = { N: 0x28a745, P: 0x007bff, K: 0xfd7e14 };
const LIQ = { N: 0x4ade80, P: 0x60a5fa, K: 0xfb923c };
const XPO = { N: -6, P: 0, K: 6 };

// ── Init ──────────────────────────────────────────────
export function init(canvasId, wrapId) {
    if (_inited) { resize(wrapId); return; }
    _inited = true;

    const canvas = document.getElementById(canvasId);
    const wrap   = document.getElementById(wrapId);
    const W = wrap.clientWidth || 760, H = wrap.clientHeight || 420;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1628);
    scene.fog = new THREE.FogExp2(0x0a1628, 0.018);

    camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 500);
    camera.position.set(0, 10, 26);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xfff0d0, 1.2);
    sun.position.set(6, 14, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x3b82f6, 0.3);
    fill.position.set(-6, 4, -8); scene.add(fill);

    // Per-column point lights
    ['N','P','K'].forEach(k => {
        const pl = new THREE.PointLight(COL[k], 0, 7);
        pl.position.set(XPO[k], 0, 1.5);
        scene.add(pl); C[`pl${k}`] = pl;
    });

    // Floor grid
    const grid = new THREE.GridHelper(40, 30, 0x1e3a5f, 0x0d2035);
    grid.position.y = -7.2; scene.add(grid);

    // Controls (limited orbit)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.06;
    controls.target.set(0, -1, 0);
    controls.minPolarAngle = Math.PI / 6; controls.maxPolarAngle = Math.PI / 2.1;
    controls.minAzimuthAngle = -Math.PI / 3.5; controls.maxAzimuthAngle = Math.PI / 3.5;
    controls.minDistance = 14; controls.maxDistance = 36;

    buildScene();
    animate();
    window.addEventListener('resize', () => resize(wrapId));
}

// ── Build Scene ───────────────────────────────────────
function mat(color, rough = 0.4, metal = 0.5, opts = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...opts });
}

function cyl(rt, rb, h, seg = 16) { return new THREE.CylinderGeometry(rt, rb, h, seg); }
function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
function sphere(r, s = 10) { return new THREE.SphereGeometry(r, s, s); }
function torus(R, r, ts = 10, rs = 20) { return new THREE.TorusGeometry(R, r, ts, rs); }

function mesh(geo, material, parent = scene) {
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
}

function buildScene() {
    ['N','P','K'].forEach(k => buildColumn(k));
    buildMixingSection();
    buildLabels();
}

function buildColumn(k) {
    const x = XPO[k], c = COL[k], liq = LIQ[k];
    const g = new THREE.Group(); g.position.x = x; scene.add(g);
    C[`g${k}`] = g;

    // ─ Bồn chứa phân ─
    const tankBody = mesh(cyl(1.1, 1.1, 3.2, 20), mat(0x1e293b, 0.25, 0.75, { transparent:true, opacity:0.82 }), g);
    tankBody.position.y = 5.2;
    // Liquid fill
    const tankLiq = mesh(cyl(0.98, 0.98, 2.4, 20), mat(c, 0.1, 0.1, { transparent:true, opacity:0.65, emissive:c, emissiveIntensity:0.08 }), g);
    tankLiq.position.y = 5.1; C[`tankLiq${k}`] = tankLiq;
    // Cap
    mesh(cyl(1.15, 1.15, 0.12, 20), mat(0x374151, 0.4, 0.8), g).position.y = 6.85;
    // Color band
    const band = mesh(cyl(1.12, 1.12, 0.28, 20), mat(c, 0.3, 0.5, { emissive:c, emissiveIntensity:0.2 }), g);
    band.position.y = 5.6; C[`band${k}`] = band;
    // Bottom nozzle
    mesh(cyl(0.14, 0.14, 1.2, 8), mat(0x4a5568, 0.3, 0.8), g).position.y = 3.2;

    // ─ Động cơ bước ─
    const motorBase = mesh(cyl(0.58, 0.58, 0.75, 20), mat(0x1f2937, 0.2, 0.9), g);
    motorBase.position.y = 2.25; C[`motor${k}`] = motorBase;
    // Rotor disc (rotating)
    const rotor = mesh(cyl(0.52, 0.52, 0.14, 20), mat(c, 0.2, 0.7, { emissive:c, emissiveIntensity:0.0 }), g);
    rotor.position.y = 2.65; C[`rotor${k}`] = rotor;
    // Shaft
    const shaft = mesh(cyl(0.07, 0.07, 0.55, 8), mat(0xd1d5db, 0.1, 1.0), g);
    shaft.position.y = 3.0; C[`shaft${k}`] = shaft;
    // Step indicator LED
    const led = mesh(sphere(0.09), mat(0x374151, 0.1, 0.1, { emissive:0x111827, emissiveIntensity:1.0 }), g);
    led.position.set(0.62, 2.25, 0); C[`led${k}`] = led;

    // ─ Pipe motor→sensor ─
    mesh(cyl(0.11, 0.11, 0.9, 8), mat(0x4a5568, 0.3, 0.8), g).position.y = 1.4;

    // ─ Cảm biến lưu lượng YF-S201 ─
    const sensor = new THREE.Mesh(torus(0.32, 0.11, 8, 18), mat(0x6b7280, 0.3, 0.7));
    sensor.rotation.x = Math.PI / 2; sensor.position.y = 0.95;
    sensor.castShadow = true; g.add(sensor); C[`sensor${k}`] = sensor;
    // Sensor body
    const sBody = mesh(cyl(0.22, 0.22, 0.28, 12), mat(0x374151, 0.3, 0.8), g);
    sBody.position.y = 0.95; C[`sbody${k}`] = sBody;
    // Sensor pulse ring
    const pring = new THREE.Mesh(torus(0.38, 0.04, 6, 18), mat(c, 0.2, 0.3, { emissive:c, emissiveIntensity:0.0, transparent:true, opacity:0.0 }));
    pring.rotation.x = Math.PI / 2; pring.position.y = 0.95;
    g.add(pring); C[`pring${k}`] = pring;

    // ─ Pipe sensor→valve ─
    mesh(cyl(0.11, 0.11, 0.75, 8), mat(0x4a5568, 0.3, 0.8), g).position.y = 0.2;

    // ─ Van điện từ solenoid ─
    const vBody = mesh(box(0.65, 0.45, 0.65), mat(0xb91c1c, 0.3, 0.6, { emissive:0x7f1d1d, emissiveIntensity:0.25 }), g);
    vBody.position.y = -0.5; C[`valve${k}`] = vBody;
    // Coil
    mesh(cyl(0.2, 0.2, 0.42, 12), mat(0x1f2937, 0.5, 0.4), g).position.y = -0.28;
    // Plunger
    const plunger = mesh(cyl(0.065, 0.065, 0.38, 8), mat(0xe5e7eb, 0.1, 1.0), g);
    plunger.position.y = -0.05; C[`plunger${k}`] = plunger;
    // Valve indicator LED
    const vled = mesh(sphere(0.1), mat(0xef4444, 0.1, 0.1, { emissive:0xef4444, emissiveIntensity:0.4 }), g);
    vled.position.set(0.38, -0.5, 0.35); C[`vled${k}`] = vled;

    // ─ Outlet pipe (angled to mixing tank) ─
    mesh(cyl(0.11, 0.11, 1.8, 8), mat(0x4a5568, 0.3, 0.8), g).position.y = -1.7;

    // Liquid particles (flow simulation)
    const particleGeo = new THREE.BufferGeometry();
    const pCount = 8;
    const pPos = new Float32Array(pCount * 3);
    particleGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ color: liq, size: 0.18, transparent: true, opacity: 0.0 });
    const pts = new THREE.Points(particleGeo, pMat);
    g.add(pts); C[`pts${k}`] = { pts, pPos, count: pCount, phase: 0, liq };
}

function buildMixingSection() {
    // Horizontal collector pipes
    [-1, 1].forEach(dir => {
        const hPipe = mesh(cyl(0.11, 0.11, 4.2, 8), mat(0x4a5568, 0.3, 0.8));
        hPipe.rotation.z = Math.PI / 2;
        hPipe.position.set(dir * 3.1, -3.6, 0);
    });
    // Center down pipe
    mesh(cyl(0.13, 0.13, 1.4, 8), mat(0x4a5568, 0.3, 0.8)).position.set(0, -4.4, 0);

    // Pump body
    const pumpBody = mesh(cyl(0.55, 0.45, 0.9, 16), mat(0x374151, 0.2, 0.9));
    pumpBody.position.set(4.2, -3.6, 0); C.pump = pumpBody;
    const impeller = mesh(cyl(0.4, 0.4, 0.12, 8), mat(0x4b5563, 0.1, 1.0));
    impeller.position.set(4.2, -3.15, 0); C.impeller = impeller;
    // Pump LED
    const pled = mesh(sphere(0.11), mat(0x22c55e, 0.1, 0.1, { emissive:0x166534, emissiveIntensity:0.4 }));
    pled.position.set(4.2, -3.6, 0.58); C.pled = pled;

    // Bồn pha trộn
    const mTank = mesh(cyl(2.2, 1.8, 2.4, 24), mat(0x1e3a5f, 0.25, 0.65, { transparent:true, opacity:0.85 }));
    mTank.position.set(0, -5.5, 0);
    const mBand = mesh(cyl(2.22, 2.22, 0.26, 24), mat(0x3b82f6, 0.3, 0.5, { emissive:0x1d4ed8, emissiveIntensity:0.2 }));
    mBand.position.set(0, -4.6, 0);
    // Mixing liquid
    const mLiq = mesh(cyl(2.0, 1.6, 1.8, 24), mat(0x22c55e, 0.08, 0.1, { transparent:true, opacity:0.55, emissive:0x14532d, emissiveIntensity:0.15 }));
    mLiq.position.set(0, -5.6, 0); C.mLiq = mLiq;
    // Stirrer
    const stir = mesh(cyl(0.05, 0.05, 2.1, 6), mat(0x9ca3af, 0.1, 0.9));
    stir.position.set(0, -5.1, 0); C.stirrer = stir;
    for (let i = 0; i < 3; i++) {
        const blade = mesh(box(1.7, 0.05, 0.13), mat(0x6b7280, 0.2, 0.8));
        blade.position.set(0, -5.8, 0);
        blade.rotation.y = (i / 3) * Math.PI * 2;
        C[`blade${i}`] = blade;
    }
}

function buildLabels() {
    // Simple colored marker discs as labels
    const labels = [
        { x: XPO.N, text: 'N', c: COL.N },
        { x: XPO.P, text: 'P', c: COL.P },
        { x: XPO.K, text: 'K', c: COL.K },
    ];
    labels.forEach(l => {
        const disc = mesh(cyl(1.15, 1.15, 0.06, 20), mat(l.c, 0.4, 0.3, { emissive:l.c, emissiveIntensity:0.15 }));
        disc.position.set(l.x, 3.56, 0);
    });
}

// ── Animation loop ────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    t += dt;
    updateComponents(dt);
    controls.update();
    renderer.render(scene, camera);
}

function updateComponents(dt) {
    const anyActive = state.N.active || state.P.active || state.K.active;

    ['N','P','K'].forEach(k => {
        const s = state[k];
        const on = s.active;

        // Point light intensity
        if (C[`pl${k}`]) C[`pl${k}`].intensity = on ? lerp(C[`pl${k}`].intensity, 1.8, dt * 4) : lerp(C[`pl${k}`].intensity, 0, dt * 3);

        // Motor rotation
        if (C[`rotor${k}`] && on) {
            C[`rotor${k}`].rotation.y += dt * 9;
            C[`shaft${k}`].rotation.y  += dt * 9;
            C[`rotor${k}`].material.emissiveIntensity = 0.45;
        } else if (C[`rotor${k}`]) {
            C[`rotor${k}`].material.emissiveIntensity = lerp(C[`rotor${k}`].material.emissiveIntensity, 0, dt * 3);
        }

        // LED step indicator blink
        if (C[`led${k}`] && on) {
            const blink = Math.sin(t * 12 + (k === 'N' ? 0 : k === 'P' ? 2 : 4)) > 0;
            C[`led${k}`].material.emissive.setHex(blink ? COL[k] : 0x111827);
            C[`led${k}`].material.emissiveIntensity = blink ? 1.2 : 0.1;
            C[`led${k}`].material.color.setHex(blink ? COL[k] : 0x374151);
        } else if (C[`led${k}`]) {
            C[`led${k}`].material.emissiveIntensity = lerp(C[`led${k}`].material.emissiveIntensity, 0.0, dt * 4);
        }

        // Flow sensor pulse ring
        if (C[`pring${k}`] && on) {
            const pulse = (Math.sin(t * 6 + (k === 'N' ? 0 : k === 'P' ? 2.1 : 4.2)) + 1) / 2;
            C[`pring${k}`].material.emissiveIntensity = pulse * 1.5;
            C[`pring${k}`].material.opacity = pulse * 0.9;
            C[`pring${k}`].scale.setScalar(1 + pulse * 0.2);
        } else if (C[`pring${k}`]) {
            C[`pring${k}`].material.opacity = lerp(C[`pring${k}`].material.opacity, 0, dt * 3);
        }

        // Valve LED & plunger
        if (C[`vled${k}`]) {
            C[`vled${k}`].material.color.setHex(on ? 0x22c55e : 0xef4444);
            C[`vled${k}`].material.emissive.setHex(on ? 0x166534 : 0x7f1d1d);
            C[`vled${k}`].material.emissiveIntensity = on ? 1.0 : 0.3;
        }
        if (C[`plunger${k}`]) {
            const targetY = on ? 0.18 : -0.05;
            C[`plunger${k}`].position.y = lerp(C[`plunger${k}`].position.y, targetY, dt * 6);
        }
        if (C[`valve${k}`]) {
            C[`valve${k}`].material.emissive.setHex(on ? 0x14532d : 0x7f1d1d);
            C[`valve${k}`].material.emissiveIntensity = on ? 0.5 : 0.2;
        }

        // Liquid particles flowing through pipe
        animateParticles(k, dt, on);
    });

    // Pump impeller spin
    if (C.impeller && anyActive) {
        C.impeller.rotation.y += dt * 12;
        C.pled.material.emissiveIntensity = 1.0;
    } else if (C.pled) {
        C.pled.material.emissiveIntensity = lerp(C.pled.material.emissiveIntensity, 0.15, dt * 2);
    }

    // Stirrer rotation when running
    if (anyActive) {
        if (C.stirrer) C.stirrer.rotation.y += dt * 3;
        for (let i = 0; i < 3; i++) if (C[`blade${i}`]) C[`blade${i}`].rotation.y += dt * 3;
        if (C.mLiq) {
            C.mLiq.material.emissiveIntensity = 0.2 + Math.sin(t * 2) * 0.05;
        }
    }
}

function animateParticles(k, dt, active) {
    const p = C[`pts${k}`]; if (!p) return;
    p.phase = (p.phase + dt * (active ? 1.6 : 0.3)) % 1;
    const pos = p.pPos;
    for (let i = 0; i < p.count; i++) {
        const frac = ((i / p.count) + p.phase) % 1;
        // Particles travel from y=3.0 (below tank) down to y=-2.7 (outlet)
        const yStart = 3.0, yEnd = -2.7;
        pos[i * 3]     = (Math.random() - 0.5) * 0.1;
        pos[i * 3 + 1] = yStart + (yEnd - yStart) * frac;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
    }
    p.pts.geometry.attributes.position.needsUpdate = true;
    p.pts.material.opacity = active ? lerp(p.pts.material.opacity, 0.85, dt * 4) : lerp(p.pts.material.opacity, 0, dt * 3);
    p.pts.material.color.setHex(p.liq);
}

function lerp(a, b, t) { return a + (b - a) * Math.min(t, 1); }

// ── Resize ────────────────────────────────────────────
export function resize(wrapId) {
    const wrap = document.getElementById(wrapId);
    if (!wrap || !renderer) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    renderer.setSize(W, H);
}

// ── Public API ────────────────────────────────────────
export function updateState(newState) {
    Object.assign(state, newState);
}
