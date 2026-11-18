import type { AmbientMediumSpec, MaterialSpec, MediumId } from '../core/types';

/**
 * 空間を満たす標準媒質（真空・気体・液体）カタログ
 */
export const DEFAULT_MEDIA: readonly AmbientMediumSpec[] = [
  {
    id: 'vacuum',
    name: '真空 (Vacuum)',
    density: 0.0,
    viscosity: 0.0,
    permittivity: 1.0,
    breakdownThreshold: 1e6,
    oxidizerRatio: 0.0,
    ambientHeat: 0.0,
  },
  {
    id: 'air',
    name: '標準大気 (Air)',
    density: 0.0012,
    viscosity: 0.045,
    permittivity: 1.0006,
    breakdownThreshold: 12.0,
    oxidizerRatio: 0.21,
    ambientHeat: 0.05,
  },
  {
    id: 'helium',
    name: 'ヘリウム (He)',
    density: 0.00018,
    viscosity: 0.008,
    permittivity: 1.0001,
    breakdownThreshold: 7.0,
    oxidizerRatio: 0.0,
    ambientHeat: 0.05,
  },
  {
    id: 'neon',
    name: 'ネオンガス (Ne)',
    density: 0.0009,
    viscosity: 0.012,
    permittivity: 1.0001,
    breakdownThreshold: 3.5,
    oxidizerRatio: 0.0,
    ambientHeat: 0.05,
  },
  {
    id: 'water',
    name: '純水 (Water)',
    density: 1.0,
    viscosity: 0.85,
    permittivity: 80.0,
    breakdownThreshold: 30.0,
    oxidizerRatio: 0.0,
    ambientHeat: 0.1,
  },
];

export function createMediumMap(): Map<MediumId, AmbientMediumSpec> {
  const map = new Map<MediumId, AmbientMediumSpec>();
  for (const m of DEFAULT_MEDIA) {
    map.set(m.id, m);
  }
  return map;
}

/**
 * 標準マテリアル物性辞書
 */
export const DEFAULT_MATERIALS: readonly MaterialSpec[] = [
  {
    id: 'iron_ball',
    name: '鉄球',
    density: 7.87,
    electronAffinity: 0.1,
    conductivity: 0.9,
    polarizability: 0.4,
    spinMagnitude: 0.0,
    magneticSusceptibility: 1.0,
    bindingEnergy: 100.0,
    staticFriction: 0.4,
    dynamicFriction: 0.25,
    restitution: 0.2,
    colorHex: 0x94a3b8,
  },
  {
    id: 'rubber_balloon',
    name: 'ゴム風船',
    density: 0.08,
    electronAffinity: 0.85,
    conductivity: 0.01,
    polarizability: 0.35,
    spinMagnitude: 0.0,
    magneticSusceptibility: 0.0,
    bindingEnergy: 20.0,
    ignitionHeat: 2.2,
    combustionEnergy: 14.0,
    staticFriction: 0.75,
    dynamicFriction: 0.6,
    restitution: 0.35,
    colorHex: 0xf43f5e,
  },
  {
    id: 'wool_cloth',
    name: 'ウール布',
    density: 0.8,
    electronAffinity: -0.75,
    conductivity: 0.01,
    polarizability: 0.3,
    spinMagnitude: 0.0,
    magneticSusceptibility: 0.0,
    bindingEnergy: 18.0,
    ignitionHeat: 2.0,
    combustionEnergy: 10.0,
    staticFriction: 0.85,
    dynamicFriction: 0.7,
    restitution: 0.05,
    colorHex: 0xfbbf24,
  },
  {
    id: 'paper',
    name: '紙片',
    density: 0.7,
    electronAffinity: -0.4,
    conductivity: 0.02,
    polarizability: 0.95,
    spinMagnitude: 0.0,
    magneticSusceptibility: 0.0,
    bindingEnergy: 15.0,
    ignitionHeat: 1.5,
    combustionEnergy: 12.0,
    staticFriction: 0.6,
    dynamicFriction: 0.45,
    restitution: 0.05,
    colorHex: 0xf8fafc,
  },
  {
    id: 'aluminum_can',
    name: 'アルミ缶',
    density: 2.7,
    electronAffinity: -0.1,
    conductivity: 0.95,
    polarizability: 0.85,
    spinMagnitude: 0.0,
    magneticSusceptibility: 0.05,
    bindingEnergy: 60.0,
    staticFriction: 0.35,
    dynamicFriction: 0.2,
    restitution: 0.25,
    colorHex: 0xcbd5e1,
  },
  {
    id: 'neodymium_magnet',
    name: 'ネオジム磁石',
    density: 7.5,
    electronAffinity: 0.05,
    conductivity: 0.85,
    polarizability: 0.3,
    spinMagnitude: 1.0,
    magneticSusceptibility: 0.9,
    bindingEnergy: 120.0,
    staticFriction: 0.45,
    dynamicFriction: 0.3,
    restitution: 0.15,
    colorHex: 0x3b82f6,
  },
  {
    id: 'steel_ground',
    name: '鋼板アース',
    density: 7.8,
    electronAffinity: 0.0,
    conductivity: 1.0,
    polarizability: 0.5,
    spinMagnitude: 0.0,
    magneticSusceptibility: 0.95,
    bindingEnergy: 150.0,
    staticFriction: 0.6,
    dynamicFriction: 0.4,
    restitution: 0.1,
    colorHex: 0x475569,
  },
  {
    id: 'ice',
    name: '氷 (Ice/Water)',
    density: 0.92,
    liquidDensityRatio: 1.09,
    electronAffinity: -0.2,
    conductivity: 0.05,
    polarizability: 0.75,
    spinMagnitude: 0.0,
    magneticSusceptibility: 0.0,
    bindingEnergy: 2.0,
    staticFriction: 0.1,
    dynamicFriction: 0.05,
    restitution: 0.1,
    colorHex: 0x7dd3fc,
  },
];

export function createMaterialMap(): Map<string, MaterialSpec> {
  const map = new Map<string, MaterialSpec>();
  for (const m of DEFAULT_MATERIALS) {
    map.set(m.id, m);
  }
  return map;
}
