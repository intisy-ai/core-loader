// core mints the capability vocabulary; this library carries no core submodule (see
// plugin-surface.ts) and takes the capability ids by injection from the loader. These declarations
// are the terminal's own narrowed view of the same shapes: only the properties it renders. A
// property core adds still reaches a caller through readSettingsSchema's spread, it just needs a
// line here before a typed reader can see it.
import type { ScreenSpec } from "./screens.js";

export interface ActionResult {
  ok: boolean;
  message?: string;
  /** Asks the surface to re-read the screen's data, because the action changed it. */
  refresh?: boolean;
}

export interface ActionSpec {
  id: string;
  label: string;
  description?: string;
  /** Text a surface must confirm with before running the action. */
  confirm?: string;
  /** Marks the action destructive, so a surface can style it as such. */
  danger?: boolean;
}

export interface FieldOption {
  label: string;
  value: string;
}

export interface FieldSpec {
  key: string;
  type?: string;
  label?: string;
  description?: string;
  options?: FieldOption[];
}

export interface SectionSpec {
  id: string;
  label: string;
  description?: string;
  fields?: string[];
  actions?: string[];
  /** Sort order among sections. Lower sorts first. */
  order?: number;
}

/** What a plugin declares on a settings surface. */
export interface CapabilitySchema {
  fields?: FieldSpec[];
  actions?: ActionSpec[];
  sections?: SectionSpec[];
}

export interface ScreenDataRequest {
  screenId: string;
  home?: string;
  refresh?: boolean;
}

export interface ScreenData {
  sources: Record<string, unknown>;
}

export interface ScreenActionRequest {
  screenId: string;
  actionId: string;
  home?: string;
  input?: Record<string, unknown>;
}

export interface ScreensCapability {
  screens(): ScreenSpec[] | Promise<ScreenSpec[]>;
  read(request: ScreenDataRequest): Promise<ScreenData>;
  invoke(request: ScreenActionRequest): Promise<ActionResult>;
}

export interface SettingsCapability {
  schema(): CapabilitySchema | Promise<CapabilitySchema>;
  run(actionId: string): Promise<ActionResult>;
}
