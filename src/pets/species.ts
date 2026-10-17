/** ペットの種類。画像とアニメーションの設定は assets.json（scripts/build-pet-assets.py が生成） */
export interface Species {
  id: string;
  name: string;
  group: 'dog' | 'cat' | 'marmot' | 'bird';
  /** 部屋に描くときの大きさ（1 コマ 256px に対する倍率） */
  scale: number;
}

export const SPECIES: Species[] = [
  { id: 'shiba', name: '柴犬', group: 'dog', scale: 0.9 },
  { id: 'golden', name: 'ゴールデンレトリバー', group: 'dog', scale: 1 },
  { id: 'corgi', name: 'コーギー', group: 'dog', scale: 0.9 },
  { id: 'tabby', name: 'サバトラ', group: 'cat', scale: 0.82 },
  { id: 'calico', name: '三毛猫', group: 'cat', scale: 0.82 },
  { id: 'ragdoll', name: 'ラグドール', group: 'cat', scale: 0.86 },
  { id: 'marmot', name: 'マーモット', group: 'marmot', scale: 0.8 },
  { id: 'budgie', name: 'セキセイインコ', group: 'bird', scale: 0.6 },
  { id: 'cockatiel', name: 'オカメインコ', group: 'bird', scale: 0.66 },
  { id: 'java_sparrow', name: '文鳥', group: 'bird', scale: 0.6 },
];

export const GROUP_LABEL: Record<Species['group'], string> = { dog: '犬', cat: '猫', marmot: 'マーモット', bird: '鳥' };

export const speciesOf = (id: string) => SPECIES.find((s) => s.id === id) ?? SPECIES[0];
