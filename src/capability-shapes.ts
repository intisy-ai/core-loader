/**
 * core mints the capability vocabulary a plugin declares its settings and screens in; this is the
 * terminal's view of it, re-exported so a rename or a retype in core fails here rather than drifting.
 */
export type {
  ActionResult,
  ActionSpec,
  CapabilitySchema,
  FieldOption,
  FieldSpec,
  ScreenActionRequest,
  ScreenData,
  ScreenDataRequest,
  ScreensCapability,
  SectionSpec,
  SettingsCapability,
} from "@intisy-ai/core";
