import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import sharp from 'sharp';
import { DELIVERY_SIZE, PIPELINE_CONFIG, runPipeline } from './convert-field-object-images.mjs';

const temporaryDirectories = [];
async function temporaryDirectory() { const directory = await mkdtemp(path.join(os.tmpdir(), 'persona-field-object-images-')); temporaryDirectories.push(directory); return directory; }
async function fixture(filePath, options = {}) {
	const { width = 1000, height = 700, left = 350, top = 100, objectWidth = 100, objectHeight = 500, alpha = 1, channels = 4 } = options;
	let image = sharp({ create: { width, height, channels, background: channels === 4 ? { r: 30, g: 150, b: 240, alpha: 0 } : { r: 30, g: 150, b: 240 } } });
	if (channels === 4) image = image.composite([{ input: { create: { width: objectWidth, height: objectHeight, channels: 4, background: { r: 240, g: 80, b: 30, alpha } } }, left, top }]);
	const input = await image.png().toBuffer();
	await writeFile(filePath, input);
}

afterEach(async () => { while (temporaryDirectories.length) await rm(temporaryDirectories.pop(), { recursive: true, force: true }); });

describe('field object image conversion pipeline', () => {
	it('trims transparent margins, contains the object, and creates a lossless alpha WebP canvas', async () => {
		const root = await temporaryDirectory(); const inputDirectory = path.join(root, 'sources'); const outputDirectory = path.join(root, 'output'); const cachePath = path.join(root, 'cache.json');
		await mkdir(inputDirectory); await fixture(path.join(inputDirectory, 'tree.png'));
		const summary = await runPipeline({ inputDirectory, outputDirectory, cachePath });
		const output = await readFile(path.join(outputDirectory, 'tree.webp')); const metadata = await sharp(output).metadata();
		const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
		expect(summary).toMatchObject({ scanned: 1, generated: 1, failed: 0 });
		expect(metadata).toMatchObject({ format: 'webp', width: DELIVERY_SIZE, height: DELIVERY_SIZE, hasAlpha: true });
		expect(PIPELINE_CONFIG).toMatchObject({ width: 256, height: 256, fit: 'contain', trim: true, lossless: true, withoutEnlargement: false });
		expect(alphaAt(0, 0)).toBe(0);
		expect(alphaAt(128, 0)).toBe(255);
		expect(alphaAt(0, 128)).toBe(0);
		expect(alphaAt(128, 128)).toBe(255);
	});

	it('rejects an input without alpha', async () => {
		const root = await temporaryDirectory(); const inputDirectory = path.join(root, 'sources');
		await mkdir(inputDirectory); await fixture(path.join(inputDirectory, 'opaque.png'), { channels: 3 });
		await expect(runPipeline({ inputDirectory, outputDirectory: path.join(root, 'output'), cachePath: path.join(root, 'cache.json') })).rejects.toThrow(/opaque\.png: source image must have an alpha channel/);
	});
});
