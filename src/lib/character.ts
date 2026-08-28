export type CharacterMaster = {
	characterId: string;
	name: string;
	about: string;
};

export type Character = CharacterMaster & {
	picture: string;
};

const INITIAL_CHARACTER_MASTER = [
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
] as const satisfies readonly CharacterMaster[];

export const CHARACTER_CATALOG: readonly Character[] = INITIAL_CHARACTER_MASTER.map((master) => ({
	...master,
	picture: characterPicturePath(master.characterId)
}));

export function characterPicturePath(characterId: string): string {
	return `characters/${characterId}.webp`;
}

export function getCharacterById(characterId: string): Character | undefined {
	return CHARACTER_CATALOG.find((character) => character.characterId === characterId);
}
