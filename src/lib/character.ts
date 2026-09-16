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
	},
	{
		characterId: '021',
		name: 'アキ',
		about: '普通にここにいる。'
	},
	{
		characterId: '022',
		name: '知らないおじさん',
		about: 'たぶん誰の知り合いでもない。'
	},
	{
		characterId: '023',
		name: 'ミウラ',
		about: '知らないものは、とりあえず匂いをかぐ。'
	},
	{
		characterId: '024',
		name: '女王様',
		about: '命令するのには慣れている。'
	},
	{
		characterId: '025',
		name: '暴走トラック',
		about: '行き先については関知しない。'
	},
	{
		characterId: '026',
		name: '猫',
		about: '猫。'
	},
	{
		characterId: '027',
		name: '転生者レン',
		about: 'たぶん、この世界ではかなり強い。'
	},
	{
		characterId: '028',
		name: 'みゆきママ',
		about: 'まあまあ、そんな日もあるわよ。'
	},
	{
		characterId: '029',
		name: 'アウストラロピテクス',
		about: '最近、立って歩くことが増えた。'
	},
	{
		characterId: '030',
		name: '幽霊',
		about: '見えてるの…？'
	},
	{
		characterId: '031',
		name: '半袖タカシ',
		about: '今日も張り切っていきましょう！'
	},
	{
		characterId: '032',
		name: 'ヴぁびｐｂな＠え',
		about: 'なとえはぎｂｖのあ＠え'
	},
	{
		characterId: '033',
		name: 'はる',
		about: 'きょうどんぐりひろった'
	},
	{
		characterId: '034',
		name: '卵',
		about: '卵'
	},
	{
		characterId: '035',
		name: '佐伯',
		about: '会うとだいたい会釈してくれる。'
	},
	{
		characterId: '036',
		name: 'コンビニ三人組',
		about: 'いらっしゃいませー'
	},
	{
		characterId: '037',
		name: '老人',
		about: '朝は早い。'
	},
	{
		characterId: '038',
		name: 'ハンク',
		about: 'とりあえず嬉しそうにしておく。'
	},
	{
		characterId: '039',
		name: '犬',
		about: '犬。'
	},
	{
		characterId: '040',
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
