export type CharacterMaster = {
	characterId: string;
	name: string;
	about: string;
};

export type Character = CharacterMaster & {
	picture: string;
};

const CHARACTER_MASTER = [
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
		about: '年齢の話はしません。'
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
		about: '尻子玉を集めてる'
	},
	{
		characterId: '011',
		name: '無口な少年',
		about: '話さないわけではない。話すことがないだけかもしれない。'
	},
	{
		characterId: '012',
		name: '石ころ',
		about: '石ころ。'
	},
	{
		characterId: '013',
		name: '木',
		about: '気づいたときにはそこにいた。'
	},
	{
		characterId: '014',
		name: 'マテオ',
		about: '少し遠くから来たような顔をしている。'
	},
	{
		characterId: '015',
		name: '自動販売機',
		about: '夜になると少しだけ存在感が増す。'
	},
	{
		characterId: '016',
		name: 'お母さん',
		about: 'ちゃんと食べているかを気にしている。'
	},
	{
		characterId: '017',
		name: 'お父さん',
		about: '最近どうしているか、聞こうと思っている。'
	},
	{
		characterId: '018',
		name: 'ゴブリン',
		about: '簿記2級'
	},
	{
		characterId: '019',
		name: 'ぽよる',
		about: 'べつに溶けてるわけじゃないです。'
	},
	{
		characterId: '020',
		name: 'アミナ',
		about: '静かな場所ではよく笑う。'
	}
] as const satisfies readonly CharacterMaster[];

export const CHARACTER_CATALOG: readonly Character[] = CHARACTER_MASTER.map((master) => ({
	...master,
	picture: characterPicturePath(master.characterId)
}));

export function characterPicturePath(characterId: string): string {
	return `characters/${characterId}.webp`;
}

export function getCharacterById(characterId: string): Character | undefined {
	return CHARACTER_CATALOG.find((character) => character.characterId === characterId);
}
