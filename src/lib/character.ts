export type CharacterMaster = {
	characterId: string;
	slot: number;
	name: string;
	about: string;
};

export type Character = CharacterMaster & {
	picture: string;
};

const CHARACTER_MASTER = [
	{
		characterId: '001',
		slot: 0,
		name: '女の子',
		about: '知らない場所でも、わりと平気そう。'
	},
	{
		characterId: '002',
		slot: 1,
		name: '全裸中年男性',
		about: '先日、カインズで「セルフレジ」を利用しました。\nセルフというからには自分自身を会計するものだと思い、商品をすべて床に置いてバーコードリーダーの前に立ったところ、店員さんが三人来ました。\n私にはバーコードがないので、結局値段は分かりませんでした。\n窓から国道沿いの店を眺めながら、値段のつかないものにも価値はあるのだろうかと考えました。\n西の空が赤くなっていました。'
	},
	{
		characterId: '003',
		slot: 2,
		name: 'アルパカ',
		about: '首の長さでアイデンティティをなんとか保っている。'
	},
	{
		characterId: '004',
		slot: 3,
		name: 'エルフ',
		about: '年齢の話はしません。'
	},
	{
		characterId: '005',
		slot: 4,
		name: '道に落ちてる軍手',
		about: '片方だけ。昨日からある気がする。'
	},
	{
		characterId: '006',
		slot: 5,
		name: '疲れた大人',
		about: '今日はもう十分やった気がしている。'
	},
	{
		characterId: '007',
		slot: 6,
		name: 'ミナ',
		about: 'よくいる人。本人はそう思っている。'
	},
	{
		characterId: '008',
		slot: 7,
		name: '旅人',
		about: 'どこかから来て、またどこかへ行くらしい。'
	},
	{
		characterId: '009',
		slot: 8,
		name: 'たこ焼き',
		about: '八個のうち、ひとつだけ会話が成立する。'
	},
	{
		characterId: '010',
		slot: 9,
		name: '河童',
		about: '尻子玉を集めてる'
	},
	{
		characterId: '011',
		slot: 10,
		name: '無口な少年',
		about: '話さないわけではない。話すことがないだけかもしれない。'
	},
	{
		characterId: '012',
		slot: 11,
		name: '石ころ',
		about: '石ころ。'
	},
	{
		characterId: '013',
		slot: 12,
		name: '木',
		about: '気づいたときにはそこにいた。'
	},
	{
		characterId: '014',
		slot: 13,
		name: 'マテオ',
		about: '少し遠くから来たような顔をしている。'
	},
	{
		characterId: '015',
		slot: 14,
		name: '自動販売機',
		about: '夜になると少しだけ存在感が増す。'
	},
	{
		characterId: '016',
		slot: 15,
		name: 'お母さん',
		about: 'ちゃんと食べているかを気にしている。'
	},
	{
		characterId: '017',
		slot: 16,
		name: 'お父さん',
		about: '最近どうしているか、聞こうと思っている。'
	},
	{
		characterId: '018',
		slot: 17,
		name: 'ゴブリン',
		about: '簿記2級'
	},
	{
		characterId: '019',
		slot: 18,
		name: 'ぽよる',
		about: 'べつに溶けてるわけじゃないです。'
	},
	{
		characterId: '020',
		slot: 19,
		name: 'アミナ',
		about: '静かな場所ではよく笑う。'
	},
	{
		characterId: '021',
		slot: 20,
		name: 'アキ',
		about: '普通にここにいる。'
	},
	{
		characterId: '022',
		slot: 21,
		name: '知らないおじさん',
		about: 'たぶん誰の知り合いでもない。'
	},
	{
		characterId: '023',
		slot: 22,
		name: 'ミウラ',
		about: '知らないものは、とりあえず匂いをかぐ。'
	},
	{
		characterId: '024',
		slot: 23,
		name: '女王様',
		about: '命令するのには慣れている。'
	},
	{
		characterId: '025',
		slot: 24,
		name: '暴走トラック',
		about: '行き先については関知しない。'
	},
	{
		characterId: '026',
		slot: 25,
		name: '猫',
		about: '猫。'
	},
	{
		characterId: '027',
		slot: 26,
		name: '転生者レン',
		about: 'たぶん、この世界ではかなり強い。'
	},
	{
		characterId: '028',
		slot: 27,
		name: 'みゆきママ',
		about: 'まあまあ、そんな日もあるわよ。'
	},
	{
		characterId: '029',
		slot: 28,
		name: 'アウストラロピテクス',
		about: '最近、立って歩くことが増えた。'
	},
	{
		characterId: '030',
		slot: 29,
		name: '幽霊',
		about: '見えてるの…？'
	},
	{
		characterId: '031',
		slot: 30,
		name: '半袖タカシ',
		about: '今日も張り切っていきましょう！'
	},
	{
		characterId: '032',
		slot: 31,
		name: 'ヴぁびｐｂな＠え',
		about: 'なとえはぎｂｖのあ＠え'
	},
	{
		characterId: '033',
		slot: 32,
		name: 'はる',
		about: 'きょうどんぐりひろった'
	},
	{
		characterId: '034',
		slot: 33,
		name: '卵',
		about: '卵'
	},
	{
		characterId: '035',
		slot: 34,
		name: '佐伯',
		about: '会うとだいたい会釈してくれる。'
	},
	{
		characterId: '036',
		slot: 35,
		name: 'コンビニ三人組',
		about: 'いらっしゃいませー'
	},
	{
		characterId: '037',
		slot: 36,
		name: '老人',
		about: '朝は早い。'
	},
	{
		characterId: '038',
		slot: 37,
		name: 'ハンク',
		about: 'とりあえず嬉しそうにしておく。'
	},
	{
		characterId: '039',
		slot: 38,
		name: '犬',
		about: '犬。'
	},
	{
		characterId: '040',
		slot: 39,
		name: '校長先生',
		about: 'みなさんが静かになるまで校長先生は…もう待たない。'
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
