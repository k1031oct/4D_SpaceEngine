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
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(4, 7, 4);
    dirLight.castShadow = true;
    this.scene.add(dirLight);

    // 机（床面）とグリッド
    const floorGeo = new THREE.PlaneGeometry(8, 8);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x162032,
      roughness: 0.85,
      metalness: 0.1,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const gridHelper = new THREE.GridHelper(4, 16, 0x38bdf8, 0x1e293b);
    gridHelper.position.y = 0.002;
    this.scene.add(gridHelper);

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
      new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.45 }),
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

    for (const snap of state.renderSnapshots) {
      activeIds.add(snap.id);
      let mesh = this.entityMeshes.get(snap.id);
      if (!mesh) {
        const geo = new THREE.SphereGeometry(snap.radius, 24, 24);
        const mat = new THREE.MeshStandardMaterial({
          color: snap.colorHex,
          roughness: 0.4,
          metalness: 0.25,
        });
        mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.userData.entityId = snap.id;
        this.scene.add(mesh);
        this.entityMeshes.set(snap.id, mesh);
      }

      mesh.position.set(snap.position[0], snap.position[1], snap.position[2]);

      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (snap.netCharge > 0.1) {
        mat.emissive.setHex(0xef4444);
        mat.emissiveIntensity = Math.min(0.8, Math.abs(snap.netCharge) * 0.25);
      } else if (snap.netCharge < -0.1) {
        mat.emissive.setHex(0x3b82f6);
        mat.emissiveIntensity = Math.min(0.8, Math.abs(snap.netCharge) * 0.25);
      } else if (snap.isSleeping) {
        mat.emissive.setHex(0x10b981);
        mat.emissiveIntensity = 0.08;
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
