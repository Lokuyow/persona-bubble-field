import { describe, expect, it } from 'vitest';
import {
	isRootBuildAllocatable,
	rootBuildCost,
	rootContextCompressionMultiplierTenths,
	rootInferenceAccelerationMultiplierTenths,
	rootMaximumLifespanMs,
	rootOverflowRewardPercent,
	usableRootPoints,
	type RootBuild
} from './rootProgression';

const HOUR = 60 * 60 * 1000;

describe('Root permanent progression', () => {
	it('caps basic allocation at nine points while retaining overflow', () => {
		const build: RootBuild = { inferenceAcceleration: 3, contextCompression: 3, hallucinationResistance: 3 };
		expect(usableRootPoints(0)).toBe(0);
		expect(usableRootPoints(12)).toBe(9);
		expect(rootBuildCost(build)).toBe(9);
		expect(isRootBuildAllocatable(build, 12)).toBe(true);
		expect(isRootBuildAllocatable({ inferenceAcceleration: 3, contextCompression: 3, hallucinationResistance: 2 }, 12)).toBe(false);
	});

	it('exposes the specified rank effects', () => {
		expect([0, 1, 2, 3].map(rootInferenceAccelerationMultiplierTenths)).toEqual([10, 20, 30, 40]);
		expect([0, 1, 2, 3].map(rootContextCompressionMultiplierTenths)).toEqual([10, 20, 30, 40]);
		expect([0, 1, 2, 3].map(rootOverflowRewardPercent)).toEqual([0, 20, 35, 50]);
		expect([0, 1, 2, 3].map(rootMaximumLifespanMs)).toEqual([7 * 24 * HOUR, 14 * 24 * HOUR, 21 * 24 * HOUR, 30 * 24 * HOUR]);
	});
});
