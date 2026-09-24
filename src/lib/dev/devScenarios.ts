export type DevScenarioCategory = 'World' | 'Speech' | 'Chatter' | 'Trace' | 'Realtime';

export type DevScenarioFixture =
	| Readonly<{ kind: 'default' }>
	| Readonly<{ kind: 'speech'; fixture: 'showcase' | 'types' | 'normal-sizes' | 'merged2' | 'merged2-long' | 'merged3' | 'merged3-long' | 'merged4' | 'merged4-long' | 'merged2-shout-long' | 'merged2-monologue-long' | 'long' | 'linebreak' | 'linebreak-five' | 'linebreak-overflow' | 'comparison' }>
	| Readonly<{ kind: 'chatter-timeline' }>
	| Readonly<{ kind: 'trace'; replies: boolean; inactiveSelf?: boolean }>
	| Readonly<{ kind: 'cooperation-defection-static'; phase: 'warning' | 'registration' | 'game' | 'ended' }>
	| Readonly<{ kind: 'cooperation-defection-playground' }>;

export type DevScenario = Readonly<{
	id: string;
	category: DevScenarioCategory;
	label: string;
	description: string;
	fixture: DevScenarioFixture;
}>;

const speech = (id: string, label: string, description: string, fixture: Exclude<DevScenarioFixture, { kind: 'default' | 'chatter-timeline' | 'trace' | 'cooperation-defection-static' | 'cooperation-defection-playground' }>): DevScenario => ({ id, category: 'Speech', label, description, fixture });

export const DEV_SCENARIOS: readonly DevScenario[] = [
	{ id: 'default', category: 'World', label: 'Default', description: 'Plain DEV World with no seeded fixture.', fixture: { kind: 'default' } },
	speech('speech-showcase', 'Speech showcase', 'Normal and merged speech presentation.', { kind: 'speech', fixture: 'showcase' }),
	speech('speech-types', 'Speech types', 'Normal, shout, and monologue speech.', { kind: 'speech', fixture: 'types' }),
	speech('speech-normal-sizes', 'Normal sizes', 'Normal bubbles at representative sizes.', { kind: 'speech', fixture: 'normal-sizes' }),
	speech('speech-merged-2', 'Merged 2', 'Two-member merged speech.', { kind: 'speech', fixture: 'merged2' }),
	speech('speech-merged-2-long', 'Merged 2 long', 'Two-member merged speech with long content.', { kind: 'speech', fixture: 'merged2-long' }),
	speech('speech-merged-3', 'Merged 3', 'Three-member merged speech.', { kind: 'speech', fixture: 'merged3' }),
	speech('speech-merged-3-long', 'Merged 3 long', 'Three-member merged speech with long content.', { kind: 'speech', fixture: 'merged3-long' }),
	speech('speech-merged-4', 'Merged 4', 'Four-member merged speech.', { kind: 'speech', fixture: 'merged4' }),
	speech('speech-merged-4-long', 'Merged 4 long', 'Four-member merged speech with long content.', { kind: 'speech', fixture: 'merged4-long' }),
	speech('speech-merged-2-shout-long', 'Merged 2 shout long', 'Two-member long shout speech.', { kind: 'speech', fixture: 'merged2-shout-long' }),
	speech('speech-merged-2-monologue-long', 'Merged 2 monologue long', 'Two-member long monologue speech.', { kind: 'speech', fixture: 'merged2-monologue-long' }),
	speech('speech-long', 'Long speech', 'Long normal and merged content.', { kind: 'speech', fixture: 'long' }),
	speech('speech-linebreak', 'Line breaks', 'Speech with explicit line breaks.', { kind: 'speech', fixture: 'linebreak' }),
	speech('speech-linebreak-five', 'Five line breaks', 'Speech that fits the five-line limit.', { kind: 'speech', fixture: 'linebreak-five' }),
	speech('speech-linebreak-overflow', 'Line break overflow', 'Speech exceeding the five-line limit.', { kind: 'speech', fixture: 'linebreak-overflow' }),
	speech('speech-comparison', 'Speech comparison', 'Comparable normal and merged bubbles.', { kind: 'speech', fixture: 'comparison' }),
	{ id: 'chatter-timeline', category: 'Chatter', label: 'Chatter timeline', description: 'Recent-message timeline with mixed participants and speech types.', fixture: { kind: 'chatter-timeline' } },
	{ id: 'trace-markers', category: 'Trace', label: 'Trace markers', description: 'Deterministic Trace marker presentation.', fixture: { kind: 'trace', replies: false } },
	{ id: 'trace-replies', category: 'Trace', label: 'Trace replies', description: 'Trace markers with a local reply tree and composer.', fixture: { kind: 'trace', replies: true } },
	{ id: 'trace-inactive-self', category: 'Trace', label: 'Trace inactive self', description: 'Trace markers with an inactive self for reactivation checks.', fixture: { kind: 'trace', replies: false, inactiveSelf: true } },
	{ id: 'cooperation-defection-warning', category: 'Realtime', label: 'Cooperation and Defection warning', description: 'Static warning phase for 協力と抜け駆け.', fixture: { kind: 'cooperation-defection-static', phase: 'warning' } },
	{ id: 'cooperation-defection-registration', category: 'Realtime', label: 'Cooperation and Defection registration', description: 'Static registration phase for 協力と抜け駆け.', fixture: { kind: 'cooperation-defection-static', phase: 'registration' } },
	{ id: 'cooperation-defection-game', category: 'Realtime', label: 'Cooperation and Defection game', description: 'Static game phase for 協力と抜け駆け.', fixture: { kind: 'cooperation-defection-static', phase: 'game' } },
	{ id: 'cooperation-defection-ended', category: 'Realtime', label: 'Cooperation and Defection ended', description: 'Static ended phase for 協力と抜け駆け.', fixture: { kind: 'cooperation-defection-static', phase: 'ended' } },
	{ id: 'cooperation-defection-playground', category: 'Realtime', label: 'Cooperation and Defection Playground', description: 'Local simulation using the production game rules.', fixture: { kind: 'cooperation-defection-playground' } }
];

const SCENARIO_BY_ID = new Map(DEV_SCENARIOS.map((scenario) => [scenario.id, scenario]));

export function resolveDevScenario(search: URLSearchParams): DevScenario {
	const id = search.get('devScenario') ?? 'default';
	const scenario = SCENARIO_BY_ID.get(id);
	if (!scenario) throw new Error(`Unknown DEV Scenario: ${id}`);
	return scenario;
}

export function getDevScenario(id: string): DevScenario | undefined {
	return SCENARIO_BY_ID.get(id);
}

export function devScenarioCategories(): readonly DevScenarioCategory[] {
	return ['World', 'Speech', 'Chatter', 'Trace', 'Realtime'];
}
