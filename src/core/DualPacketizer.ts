import type { MaterialSpec, SpaceEntity, Vec3 } from './types';

interface ClusterState {
  readonly clusterId: string;
  readonly childIds: string[];
  lastPosition: Vec3;
  lastVelocity: Vec3;
  lastResidualStrain: number;
  lastElasticEnergy: number;
}

/**
 * 双対階層パケッタイザ（Dual-Hierarchy Co-Packetizer）
 * 空間パケットのサイズ L の変化とオブジェクト群の粒度を 1対1 で同期させ、
 * 粗視化時の統合（Pack + 多重極展開）と、細分化時の展開（Unpack）を実行する。
 * @see 4d_scale_space_engine.md §2.3
 */
export class DualPacketizer {
  private readonly activeClusters = new Map<string, ClusterState>();

  /**
   * 現在の空間パケットサイズ L に合わせてエンティティ群を Pack / Unpack する
   */
  public synchronize(
    entities: SpaceEntity[],
    cellSize: number,
    materials?: ReadonlyMap<string, MaterialSpec>,
  ): SpaceEntity[] {
    // 1. まず展開（Unpack）条件をチェック：L が十分小さくなったクラスターを展開（ヒステリシス上限 0.28 * cellSize）
    for (const [clusterId, clusterState] of Array.from(this.activeClusters.entries())) {
      const clusterEnt = entities.find((e) => e.id === clusterId);
      const children = entities.filter((e) => clusterState.childIds.includes(e.id));

      // 子オブジェクトの最大半径がパケットサイズの 0.28 倍以上、または臨界アップスケールトリガー発動時に展開
      const maxChildRadius = children.reduce((m, c) => Math.max(m, c.radius), 0);
      const shouldUnpack =
        !clusterEnt || maxChildRadius >= cellSize * 0.28 || Boolean(clusterEnt.isCriticalSubgrid);

      if (shouldUnpack) {
        if (clusterEnt) {
          // クラスターとしての移動量・速度変化・残留歪み・弾性エネルギー増分を子オブジェクトへ還元
          const dx = clusterEnt.position[0] - clusterState.lastPosition[0];
          const dy = clusterEnt.position[1] - clusterState.lastPosition[1];
          const dz = clusterEnt.position[2] - clusterState.lastPosition[2];
          const dvx = clusterEnt.velocity[0] - clusterState.lastVelocity[0];
          const dvy = clusterEnt.velocity[1] - clusterState.lastVelocity[1];
          const dvz = clusterEnt.velocity[2] - clusterState.lastVelocity[2];
          const childCount = Math.max(children.length, 1);
          const dStrain =
            ((clusterEnt.residualStrain ?? 0) - clusterState.lastResidualStrain) / childCount;
          const dElastic =
            ((clusterEnt.elasticEnergy ?? 0) - clusterState.lastElasticEnergy) / childCount;

          for (const child of children) {
            child.position[0] += dx;
            child.position[1] += dy;
            child.position[2] += dz;
            child.velocity[0] += dvx;
            child.velocity[1] += dvy;
            child.velocity[2] += dvz;
            child.residualStrain = Math.max(0, (child.residualStrain ?? 0) + dStrain);
            child.elasticEnergy = Math.max(0, (child.elasticEnergy ?? 0) + dElastic);
            child.packedIntoId = undefined;
            child.domainClass = 'Visible';
            if (clusterEnt.isCriticalSubgrid) {
              child.isCriticalSubgrid = true;
            }
          }
        } else {
          for (const child of children) {
            child.packedIntoId = undefined;
          }
        }
        this.activeClusters.delete(clusterId);
      } else if (clusterEnt) {
        // クラスター継続中：基準位置のみ最新化（歪み・弾性エネルギーは Pack 時の初期値を保持し累積増分を Unpack 時に還元）
        clusterState.lastPosition = [...clusterEnt.position];
        clusterState.lastVelocity = [...clusterEnt.velocity];
      }
    }

    // 展開されたクラスター本体を除去
    let workingEntities = entities.filter(
      (e) => !e.id.startsWith('cluster_') || this.activeClusters.has(e.id),
    );

    // 2. 統合（Pack）条件をチェック：同一空間セル内に半径 < 0.20 * cellSize の Visible 物体が2つ以上ある場合（ヒステリシス下限）
    const cellGroups = new Map<string, SpaceEntity[]>();
    for (const ent of workingEntities) {
      if (ent.domainClass !== 'Visible' || ent.packedIntoId || ent.id.startsWith('cluster_')) {
        continue;
      }
      if (ent.radius < cellSize * 0.2 && !ent.isGrabbed && !ent.isGrounded) {
        const cx = Math.floor(ent.position[0] / cellSize);
        const cy = Math.floor(ent.position[1] / cellSize);
        const cz = Math.floor(ent.position[2] / cellSize);
        const key = `${cx},${cy},${cz}`;
        const list = cellGroups.get(key) ?? [];
        list.push(ent);
        cellGroups.set(key, list);
      }
    }

    for (const [cellKey, group] of cellGroups.entries()) {
      if (group.length < 2) continue;
      // すでに臨界アップスケールトリガーで展開済みのグループは再統合しない
      const alreadyTriggered = group.some((g) => g.isCriticalSubgrid);
      if (alreadyTriggered) continue;

      const clusterId = `cluster_${cellKey}_${group.map((g) => g.id).join('_')}`;
      if (this.activeClusters.has(clusterId)) continue;

      const clusterEntity = this.packGroup(clusterId, group, materials);
      for (const child of group) {
        child.packedIntoId = clusterId;
        child.domainClass = 'Absorbed';
      }
      this.activeClusters.set(clusterId, {
        clusterId,
        childIds: group.map((g) => g.id),
        lastPosition: [...clusterEntity.position],
        lastVelocity: [...clusterEntity.velocity],
        lastResidualStrain: clusterEntity.residualStrain ?? 0,
        lastElasticEnergy: clusterEntity.elasticEnergy ?? 0,
      });
      workingEntities = [...workingEntities, clusterEntity];
    }

    return workingEntities;
  }

  public reset(): void {
    this.activeClusters.clear();
  }

  /**
   * 複数オブジェクトを多重極展開（Q_net, p, m, U_conf）で1つの合成クラスターへ圧縮する
   */
  private packGroup(
    clusterId: string,
    group: SpaceEntity[],
    materials?: ReadonlyMap<string, MaterialSpec>,
  ): SpaceEntity {
    let totalMass = 0;
    let cmX = 0;
    let cmY = 0;
    let cmZ = 0;
    let momX = 0;
    let momY = 0;
    let momZ = 0;
    let netCharge = 0;
    let magX = 0;
    let magY = 0;
    let magZ = 0;
    let internalHeat = 0;
    let totalResidualStrain = 0;
    let totalElasticEnergy = 0;
    let minBindingEnergy = Infinity;

    for (const e of group) {
      totalMass += e.mass;
      cmX += e.mass * e.position[0];
      cmY += e.mass * e.position[1];
      cmZ += e.mass * e.position[2];
      momX += e.mass * e.velocity[0];
      momY += e.mass * e.velocity[1];
      momZ += e.mass * e.velocity[2];
      netCharge += e.netCharge;
      magX += e.magneticMoment[0];
      magY += e.magneticMoment[1];
      magZ += e.magneticMoment[2];
      internalHeat += e.internalHeat;
      totalResidualStrain += e.residualStrain ?? 0;
      totalElasticEnergy += e.elasticEnergy ?? 0;
      const binding = materials?.get(e.materialId)?.bindingEnergy;
      if (binding !== undefined && binding < minBindingEnergy) {
        minBindingEnergy = binding;
      }
    }
    const barrierThreshold = Number.isFinite(minBindingEnergy) ? minBindingEnergy : 15.0;

    const invM = 1.0 / Math.max(totalMass, 1e-6);
    const cm: Vec3 = [cmX * invM, cmY * invM, cmZ * invM];
    const vCm: Vec3 = [momX * invM, momY * invM, momZ * invM];

    // 1次モーメント（双極子・異方性軸）と2次モーメント（分散 σ_E²・局所ピーク δE_max）を算出
    let dipX = 0;
    let dipY = 0;
    let dipZ = 0;
    let maxDist = 0;
    let anisoX = 0;
    let anisoY = 0;
    let anisoZ = 0;
    const childEnergies: number[] = [];

    for (const e of group) {
      const rx = e.position[0] - cm[0];
      const ry = e.position[1] - cm[1];
      const rz = e.position[2] - cm[2];
      dipX += e.netCharge * rx;
      dipY += e.netCharge * ry;
      dipZ += e.netCharge * rz;

      const dvx = e.velocity[0] - vCm[0];
      const dvy = e.velocity[1] - vCm[1];
      const dvz = e.velocity[2] - vCm[2];
      const relK = 0.5 * e.mass * (dvx * dvx + dvy * dvy + dvz * dvz);
      internalHeat += relK;

      const eLocal = e.internalHeat + relK;
      childEnergies.push(eLocal);
      anisoX += eLocal * rx;
      anisoY += eLocal * ry;
      anisoZ += eLocal * rz;

      const d = Math.sqrt(rx * rx + ry * ry + rz * rz) + e.radius;
      if (d > maxDist) maxDist = d;
    }

    const meanE = childEnergies.reduce((s, v) => s + v, 0) / Math.max(childEnergies.length, 1);
    let variance = 0;
    let peakDev = 0;
    for (const eVal of childEnergies) {
      const dev = eVal - meanE;
      variance += dev * dev;
      if (dev > peakDev) peakDev = dev;
    }
    variance /= Math.max(childEnergies.length, 1);

    // 臨界ホットスポット判定: E_bar + δE_max >= 最小結合エネルギー障壁
    const isCriticalSubgrid = meanE + peakDev >= barrierThreshold;

    return {
      id: clusterId,
      materialId: group[0].materialId,
      position: cm,
      velocity: vCm,
      angularVelocity: [0, 0, 0],
      radius: maxDist,
      residualStrain: totalResidualStrain,
      elasticEnergy: totalElasticEnergy,
      mass: totalMass,
      netCharge,
      dipoleMoment: [dipX, dipY, dipZ],
      magneticMoment: [magX, magY, magZ],
      internalHeat,
      deviationVariance: variance,
      peakDeviation: peakDev,
      anisotropyAxis: [anisoX, anisoY, anisoZ],
      isCriticalSubgrid,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
  }
}
