import type { Pack } from './types';

export interface GroundPalette {
  label: string;
  bg: string;
  ground: string;
  lawn: string;
  water: string;
  brush: string;
  brushD: string;
  brushHi: string;
  road: string;
  roadLine: string;
  sidewalk: string;
  lot: string;
  slabFront: string;
  slabSide: string;
  char: string;
  grainOp: number;
  lampOp: number;
  trunk: string;
  canD: string;
  can: string;
  canHi: string;
  palm: string;
  shrubD: string;
  shrub: string;
  smoke: string;
  smokeOp: number;
  glowOp: number;
}

export const PALETTES: Record<Pack, GroundPalette> = {
  night: {
    label: 'Night Watch',
    bg: 'radial-gradient(110% 85% at 62% 62%, #1B2338 0%, #0E1322 52%, #070A12 100%)',
    ground: '#151C2B', lawn: '#16231E', water: '#0F2134', brush: '#2A2A23', brushD: '#1C1D19', brushHi: '#3B392D',
    road: '#0B1019', roadLine: '#3E4A63', sidewalk: '#222B3D', lot: '#101624', slabFront: '#0E131E', slabSide: '#090D15',
    char: '#2A211D', grainOp: 0.35, lampOp: 0.85, trunk: '#1E1A19', canD: '#132219', can: '#1D3226', canHi: '#2A4735',
    palm: '#22402E', shrubD: '#23271D', shrub: '#333A29', smoke: '#1A1C22', smokeOp: 0.55, glowOp: 0.9,
  },
  dusk: {
    label: 'Golden Hour',
    bg: 'radial-gradient(120% 90% at 28% 8%, #F8DDB0 0%, #E9AE7B 36%, #9A6460 72%, #3B2C3B 100%)',
    ground: '#CDB98C', lawn: '#9DAA6B', water: '#6E9AA8', brush: '#B89B63', brushD: '#8E7445', brushHi: '#D6BD82',
    road: '#4F4B48', roadLine: '#EDE3C8', sidewalk: '#DCCFB3', lot: '#77716A', slabFront: '#8A6C4C', slabSide: '#6C543A',
    char: '#3A2E27', grainOp: 0.25, lampOp: 0, trunk: '#5A3F2B', canD: '#4E6A39', can: '#6E8A47', canHi: '#9DB065',
    palm: '#6F8C4A', shrubD: '#8B7A4A', shrub: '#A8955C', smoke: '#5E4D48', smokeOp: 0.5, glowOp: 0.6,
  },
  maquette: {
    label: 'Studio Maquette',
    bg: 'linear-gradient(180deg, #F5F3EF 0%, #E2DED7 100%)',
    ground: '#DCC197', lawn: '#D2B888', water: '#D7E2E6', brush: '#CDB287', brushD: '#BDA177', brushHi: '#E4CCA4',
    road: '#F4EFE6', roadLine: '#D3C6AF', sidewalk: '#EAE2D2', lot: '#ECE5D7', slabFront: '#B8976B', slabSide: '#A2835A',
    char: '#5A504A', grainOp: 0.12, lampOp: 0, trunk: '#CDBFA5', canD: '#DDD7CB', can: '#EFEBE3', canHi: '#FFFFFF',
    palm: '#E2DCCF', shrubD: '#DCD4C5', shrub: '#ECE7DD', smoke: '#8F877E', smokeOp: 0.35, glowOp: 0.4,
  },
};

export const STATUS_COLORS = {
  green: '#3DD68C',
  amber: '#F2A93B',
  red: '#FF5A4E',
  gray: '#8A94A8',
};
