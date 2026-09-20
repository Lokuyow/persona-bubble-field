import { NORMAL_CLEAR_THRESHOLD } from './rootIdentity';

export const CLEAR_DEV_INITIAL_POINTS = NORMAL_CLEAR_THRESHOLD;

export function isClearDevMode(dev: boolean, mode: string): boolean {
	return dev && mode === 'clear';
}

export const clearDevMode = isClearDevMode(import.meta.env.DEV, import.meta.env.MODE);
