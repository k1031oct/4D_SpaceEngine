import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SpacePacketGrid } from '../core/SpacePacketGrid';
import type { DebugOverlayMode, Vec3 } from '../core/types';
import type { SandboxUiState } from '../viewmodel/SandboxUiState';
import type { SandboxViewModel } from '../viewmodel/SandboxViewModel';

/**
 * Three.js による3D描画・インタラクションアダプター
 * 演算コアとは完全に分離されており、SandboxUiState を購読して画面を更新する。
 */
export class ThreeViewAdapter {
  private readonly container: HTMLElement;
  private readonly viewModel: SandboxViewModel;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;

  private readonly entityMeshes = new Map<string, THREE.Mesh>();
  private readonly roomGroup = new THREE.Group();
  private fieldOverlayMesh: THREE.InstancedMesh | null = null;
  private windowWireMesh: THREE.LineSegments | null = null;
  private readonly dummyObj = new THREE.Object3D();
  private readonly tempColor = new THREE.Color();

  // レイキャスト・掴み操作用
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly dragPlane = new THREE.Plane();
  private readonly dragOffset = new THREE.Vector3();
  private grabbedEntityId: string | null = null;
  private lastDragTime = performance.now();

  constructor(container: HTMLElement, viewModel: SandboxViewModel) {
    this.container = container;
    this.viewModel = viewModel;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f17);

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.05, 100);
    this.camera.position.set(2.8, 2.5, 3.6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.9, 0);
    this.controls.enableDamping = true;
    this.controls.update();

    this.setupLightsAndStage();
    this.setupFieldOverlay(viewModel.core.grid);
    this.bindEvents();
  }

  private setupLightsAndStage(): void {
    const ambient = new THREE.AmbientLight(0xe2e8f0, 0.65);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xfffbeb, 1.35);
    dirLight.position.set(3.5, 6.5, 4.0);
    dirLight.castShadow = true;
    this.scene.add(dirLight);

    const fillLight = new THREE.PointLight(0x38bdf8, 0.4, 12);
    fillLight.position.set(-3, 3, -2);
    this.scene.add(fillLight);

    // 地球上の一部屋（実験デスク・部屋の床・壁・窓）
    this.scene.add(this.roomGroup);

    // 1. 木製実験デスク天板（上面が y = 0.0）
    const deskTopGeo = new THREE.BoxGeometry(3.8, 0.08, 2.4);
    const deskTopMat = new THREE.MeshStandardMaterial({
      color: 0x7c4a2d,
      roughness: 0.72,
      metalness: 0.05,
    });
    const deskTop = new THREE.Mesh(deskTopGeo, deskTopMat);
    deskTop.position.set(0, -0.04, 0);
    deskTop.receiveShadow = true;
    this.roomGroup.add(deskTop);

    // デスクのスチール脚 4本
    const legGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.75, 12);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.7, roughness: 0.35 });
    for (const lx of [-1.7, 1.7]) {
      for (const lz of [-1.0, 1.0]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(lx, -0.455, lz);
        this.roomGroup.add(leg);
      }
    }

    // 2. 部屋のフローリング床 (y = -0.83)
    const roomFloorGeo = new THREE.PlaneGeometry(10, 10);
    const roomFloorMat = new THREE.MeshStandardMaterial({
      color: 0x2a1d17,
      roughness: 0.85,
    });
    const roomFloor = new THREE.Mesh(roomFloorGeo, roomFloorMat);
    roomFloor.rotation.x = -Math.PI / 2;
    roomFloor.position.y = -0.83;
    roomFloor.receiveShadow = true;
    this.roomGroup.add(roomFloor);

    // 3. 部屋の壁（背面 & 左側面）と窓
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 0.1), wallMat);
    backWall.position.set(0, 1.67, -2.2);
    backWall.receiveShadow = true;
    this.roomGroup.add(backWall);

    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.1, 5, 10), wallMat);
    leftWall.position.set(-3.2, 1.67, 0);
    leftWall.receiveShadow = true;
    this.roomGroup.add(leftWall);

    // 背面の窓（外の空光）
    const windowGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 1.4),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25 }),
    );
    windowGlow.position.set(-0.6, 1.4, -2.14);
    this.roomGroup.add(windowGlow);

    const gridHelper = new THREE.GridHelper(3.6, 18, 0x38bdf8, 0x334155);
    gridHelper.position.y = 0.002;
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.25;
    this.roomGroup.add(gridHelper);

    // 演算窓（計算境界）のワイヤーフレーム表示
    const cfg = this.viewModel.core.config;
    const boxGeo = new THREE.BoxGeometry(
      cfg.nx * cfg.cellSize,
      cfg.ny * cfg.cellSize,
      cfg.nz * cfg.cellSize,
    );
    const edges = new THREE.EdgesGeometry(boxGeo);
    this.windowWireMesh = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.35 }),
    );
    this.windowWireMesh.position.set(cfg.center[0], cfg.center[1], cfg.center[2]);
    this.scene.add(this.windowWireMesh);
  }

  private setupFieldOverlay(grid: SpacePacketGrid): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    this.fieldOverlayMesh = new THREE.InstancedMesh(geo, mat, grid.count);
    this.fieldOverlayMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.fieldOverlayMesh);
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.onResize);
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  public dispose(): void {
    window.removeEventListener('resize', this.onResize);
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.renderer.dispose();
  }

  private onResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private updatePointer(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const meshes = Array.from(this.entityMeshes.values());
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return;

    const hitMesh = hits[0].object as THREE.Mesh;
    const entityId = hitMesh.userData.entityId as string | undefined;
    if (!entityId) return;

    this.grabbedEntityId = entityId;
    this.controls.enabled = false;
    this.viewModel.grabEntity(entityId);
    this.lastDragTime = performance.now();

    // Shiftキーで垂直平面、通常は水平平面でドラッグ
    if (e.shiftKey) {
      const camDir = new THREE.Vector3();
      this.camera.getWorldDirection(camDir);
      camDir.y = 0;
      camDir.normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(camDir, hits[0].point);
    } else {
      this.dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), hitMesh.position);
    }
    this.dragOffset.copy(hitMesh.position).sub(hits[0].point);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.grabbedEntityId) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hitPoint = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.dragPlane, hitPoint)) {
      hitPoint.add(this.dragOffset);
      const now = performance.now();
      const dt = (now - this.lastDragTime) / 1000;
      this.lastDragTime = now;
      const target: Vec3 = [hitPoint.x, hitPoint.y, hitPoint.z];
      this.viewModel.moveGrabbedEntity(this.grabbedEntityId, target, dt);
    }
  };

  private onPointerUp = (): void => {
    if (!this.grabbedEntityId) return;
    this.viewModel.releaseEntity(this.grabbedEntityId);
    this.grabbedEntityId = null;
    this.controls.enabled = true;
  };

  /**
   * SandboxUiState に基づいて3Dシーンを更新・描画する
   */
  public render(state: SandboxUiState): void {
    this.syncEntities(state);
    this.syncFieldOverlay(state.debugOverlayMode);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private syncEntities(state: SandboxUiState): void {
    const activeIds = new Set<string>();
    this.roomGroup.visible = this.viewModel.core.grid.cellSize <= 2.0;

    for (const snap of state.renderSnapshots) {
      activeIds.add(snap.id);
      let mesh = this.entityMeshes.get(snap.id);
      if (!mesh) {
        mesh = this.createEntityMesh(snap);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.entityId = snap.id;
        this.scene.add(mesh);
        this.entityMeshes.set(snap.id, mesh);
      }

      mesh.position.set(snap.position[0], snap.position[1], snap.position[2]);

      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (snap.phaseState === 'gas') {
        mesh.scale.set(1.5, 1.5, 1.5);
        mat.transparent = true;
        mat.opacity = 0.35;
      } else if (snap.phaseState === 'liquid') {
        mesh.scale.set(1.2, 0.7, 1.2);
        mat.transparent = true;
        mat.opacity = 0.78;
      } else {
        mesh.scale.set(1, 1, 1);
        mat.transparent = snap.materialId === 'ice';
        mat.opacity = snap.materialId === 'ice' ? 0.72 : 1.0;
      }

      if (snap.netCharge > 0.1) {
        mat.emissive.setHex(0xef4444);
        mat.emissiveIntensity = Math.min(0.8, Math.abs(snap.netCharge) * 0.25);
      } else if (snap.netCharge < -0.1) {
        mat.emissive.setHex(0x3b82f6);
        mat.emissiveIntensity = Math.min(0.8, Math.abs(snap.netCharge) * 0.25);
      } else if (snap.isSleeping) {
        mat.emissive.setHex(0x10b981);
        mat.emissiveIntensity = 0.06;
      } else {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
      }
    }

    // 削除されたエンティティをシーンから除去
    for (const [id, mesh] of this.entityMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.entityMeshes.delete(id);
      }
    }
  }

  /**
   * 現実のオブジェクト形状・質感に合わせた3Dメッシュを生成する
   */
  private createEntityMesh(snap: SandboxUiState['renderSnapshots'][number]): THREE.Mesh {
    const [w, h, d] = snap.dimensions;
    const isMetal =
      snap.materialId === 'iron_ball' ||
      snap.materialId === 'aluminum_can' ||
      snap.materialId === 'steel_ground' ||
      snap.materialId === 'neodymium_magnet';

    const mat = new THREE.MeshStandardMaterial({
      color: snap.colorHex,
      roughness: snap.materialId === 'ice' ? 0.1 : isMetal ? 0.25 : 0.65,
      metalness: isMetal ? 0.8 : 0.05,
      transparent: snap.materialId === 'ice',
      opacity: snap.materialId === 'ice' ? 0.72 : 1.0,
    });

    if (snap.shape === 'box' || snap.shape === 'sheet') {
      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo, mat);
      // 鋼板冷蔵庫（steel_ground）にはアースライン装飾を追加
      if (snap.materialId === 'steel_ground' && h > 0.5) {
        const doorLine = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.92, 0.015, 0.02),
          new THREE.MeshBasicMaterial({ color: 0x1e293b }),
        );
        doorLine.position.set(0, h * 0.1, d * 0.5);
        mesh.add(doorLine);
      }
      return mesh;
    }

    if (snap.shape === 'cylinder') {
      const r = Math.max(w, d) * 0.5;
      const geo = new THREE.CylinderGeometry(r, r, h, 24);
      const mesh = new THREE.Mesh(geo, mat);
      // ネオジム磁石はN極(赤)・S極(青)のキャップを表示
      if (snap.materialId === 'neodymium_magnet') {
        const nCap = new THREE.Mesh(
          new THREE.CylinderGeometry(r * 0.99, r * 0.99, h * 0.45, 24),
          new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.6, roughness: 0.3 }),
        );
        nCap.position.y = h * 0.26;
        mesh.add(nCap);
      }
      return mesh;
    }

    if (snap.shape === 'balloon') {
      const geo = new THREE.SphereGeometry(snap.radius, 24, 24);
      geo.scale(0.88, 1.08, 0.88);
      const mesh = new THREE.Mesh(geo, mat);
      const knot = new THREE.Mesh(
        new THREE.ConeGeometry(snap.radius * 0.16, snap.radius * 0.25, 12),
        mat,
      );
      knot.position.y = -snap.radius * 1.1;
      mesh.add(knot);
      return mesh;
    }

    // デフォルト: 球体（鉄球・天体など）
    const geo = new THREE.SphereGeometry(snap.radius, 24, 24);
    return new THREE.Mesh(geo, mat);
  }

  private syncFieldOverlay(mode: DebugOverlayMode): void {
    const inst = this.fieldOverlayMesh;
    if (!inst) return;

    if (mode === 'none') {
      inst.visible = false;
      return;
    }
    inst.visible = true;

    const grid = this.viewModel.core.grid;
    if (this.windowWireMesh) {
      const s = grid.cellSize / 0.25;
      this.windowWireMesh.scale.set(s, s, s);
      const cfg = this.viewModel.core.config;
      this.windowWireMesh.position.set(cfg.center[0], cfg.center[1], cfg.center[2]);
    }

    if (mode === 'octree') {
      const nodes = this.viewModel.core.grid.extractFoveatedOctree(this.viewModel.core.config.center);
      let i = 0;
      for (; i < nodes.length && i < grid.count; i++) {
        const n = nodes[i];
        const s = n.size * 0.78;
        this.dummyObj.position.set(n.center[0], n.center[1], n.center[2]);
        this.dummyObj.scale.set(s, s, s);
        this.dummyObj.updateMatrix();
        inst.setMatrixAt(i, this.dummyObj.matrix);
        this.tempColor.setHex(n.level === 1 ? 0x38bdf8 : 0x64748b);
        inst.setColorAt(i, this.tempColor);
      }
      for (; i < grid.count; i++) {
        this.dummyObj.scale.set(0, 0, 0);
        this.dummyObj.updateMatrix();
        inst.setMatrixAt(i, this.dummyObj.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      return;
    }

    let instanceIdx = 0;

    for (let z = 0; z < grid.nz; z++) {
      for (let y = 0; y < grid.ny; y++) {
        for (let x = 0; x < grid.nx; x++) {
          const idx = grid.index(x, y, z);
          let val = 0;
          if (mode === 'pressure') {
            val = grid.phi[idx];
          } else if (mode === 'vorticity') {
            val = Math.sqrt(
              grid.wx[idx] * grid.wx[idx] +
                grid.wy[idx] * grid.wy[idx] +
                grid.wz[idx] * grid.wz[idx],
            );
          }

          if (Math.abs(val) < 0.05) {
            this.dummyObj.scale.set(0, 0, 0);
            this.dummyObj.updateMatrix();
            inst.setMatrixAt(instanceIdx, this.dummyObj.matrix);
          } else {
            const p = grid.packetCenter(x, y, z);
            const s = grid.cellSize * 0.65 * Math.min(1.0, Math.abs(val) * 0.2);
            this.dummyObj.position.set(p[0], p[1], p[2]);
            this.dummyObj.scale.set(s, s, s);
            this.dummyObj.updateMatrix();
            inst.setMatrixAt(instanceIdx, this.dummyObj.matrix);

            if (mode === 'pressure') {
              this.tempColor.setHex(val > 0 ? 0xf87171 : 0x60a5fa);
            } else {
              this.tempColor.setHex(0xc084fc);
            }
            inst.setColorAt(instanceIdx, this.tempColor);
          }
          instanceIdx++;
        }
      }
    }

    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) {
      inst.instanceColor.needsUpdate = true;
    }
  }
}
