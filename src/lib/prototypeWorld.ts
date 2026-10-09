export {
	assertPrototypeWorldConfig,
	PROTOTYPE_WORLD_CONFIG,
	type PrototypeWorldConfig
} from './prototypeWorldConfig';
import { PROTOTYPE_WORLD_CONFIG, type PrototypeWorldConfig } from './prototypeWorldConfig';

/**
 * DEV/test-only world injection used by browser fixtures. Production builds
 * always use the configured prototype channel and authoritative Relay set.
 */
export function resolvePrototypeWorldConfig(): PrototypeWorldConfig {
	if (!import.meta.env.DEV || typeof window === 'undefined') return PROTOTYPE_WORLD_CONFIG;
	const override = (window as Window & {
		__personaBubbleFieldTestWorldConfig?: PrototypeWorldConfig;
	}).__personaBubbleFieldTestWorldConfig;
	if (!override) return PROTOTYPE_WORLD_CONFIG;
	return Object.freeze({ ...override, authoritativeRelays: Object.freeze([...override.authoritativeRelays]) });
}
