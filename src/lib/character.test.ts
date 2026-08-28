import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	CHARACTER_CATALOG,
	characterPicturePath,
	getCharacterById
} from './character';

const STATIC_CHARACTERS_PATH = fileURLToPath(new URL('../../static/characters/', import.meta.url));

const EXPECTED_CHARACTERS = [
	{
		characterId: '001',
		name: '女の子',
		about: '知らない場所でも、わりと平気そう。'
	},
	{
		characterId: '002',
		name: '全裸中年男性',
		about: '先日、カインズで「セルフレジ」を利用しました。\nセルフというからには自分自身を会計するものだと思い、商品をすべて床に置いてバーコードリーダーの前に立ったところ、店員さんが三人来ました。\n私にはバーコードがないので、結局値段は分かりませんでした。\n窓から国道沿いの店を眺めながら、値段のつかないものにも価値はあるのだろうかと考えました。\n西の空が赤くなっていました。'
	},
	{
		characterId: '003',
		name: 'アルパカ',
		about: '首の長さでアイデンティティをなんとか保っている。'
	},
	{
		characterId: '004',
		name: 'エルフ',
		about: '長く生きているらしいが、年齢の話はしない。'
	},
	{
		characterId: '005',
		name: '道に落ちてる軍手',
		about: '片方だけ。昨日からある気がする。'
	},
	{
		characterId: '006',
		name: '疲れた大人',
		about: '今日はもう十分やった気がしている。'
	},
	{
		characterId: '007',
		name: 'ミナ',
		about: 'よくいる人。本人はそう思っている。'
	},
	{
		characterId: '008',
		name: '旅人',
		about: 'どこかから来て、またどこかへ行くらしい。'
	},
	{
		characterId: '009',
		name: 'たこ焼き',
		about: '八個のうち、ひとつだけ会話が成立する。'
	},
	{
		characterId: '010',
		name: '河童',
		about: '頭の皿が乾くことより、皿について聞かれることの方を嫌がる。'
	}
] as const;

describe('character catalog', () => {
	it('contains the exact initial character master data', () => {
		expect(CHARACTER_CATALOG.map(({ characterId, name, about }) => ({ characterId, name, about })))
			.toEqual(EXPECTED_CHARACTERS);
	});

	it('has unique character IDs and names', () => {
		expect(new Set(CHARACTER_CATALOG.map((character) => character.characterId)).size)
			.toBe(CHARACTER_CATALOG.length);
		expect(new Set(CHARACTER_CATALOG.map((character) => character.name)).size)
			.toBe(CHARACTER_CATALOG.length);
	});

	it('derives picture paths deterministically from character IDs', () => {
		expect(characterPicturePath('001')).toBe('characters/001.webp');
		expect(characterPicturePath('010')).toBe('characters/010.webp');
		expect(CHARACTER_CATALOG.map((character) => character.picture)).toEqual(
			CHARACTER_CATALOG.map((character) => characterPicturePath(character.characterId))
		);
	});

	it('has a corresponding static image for every master entry', () => {
		for (const character of CHARACTER_CATALOG) {
			expect(existsSync(`${STATIC_CHARACTERS_PATH}${character.characterId}.webp`)).toBe(true);
		}
	});

	it('retrieves characters by ID without an implicit fallback', () => {
		expect(getCharacterById('001')?.name).toBe('女の子');
		expect(getCharacterById('999')).toBeUndefined();
		expect(getCharacterById('')).toBeUndefined();
	});

	it('does not expose slot or pubkey assignment data', () => {
		for (const character of CHARACTER_CATALOG) {
			expect(character).not.toHaveProperty('slot');
			expect(character).not.toHaveProperty('pubkey');
		}
	});
});
