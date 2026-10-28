import type { ProviderConfig, ProviderKind } from "../../../shared/types";
import { DEFAULT_BASE_URL, withProviderKind } from "./draft";
import { ApiKeyField, ChoiceGroup, TextField, type ChoiceOption } from "./fields";

const KIND_OPTIONS: readonly ChoiceOption<ProviderKind>[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
];

export interface ProviderErrors {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

interface ProviderFieldsProps {
  /** Uniquely prefixes control ids when several providers share a page. */
  idPrefix: string;
  value: ProviderConfig;
  onChange: (next: ProviderConfig) => void;
  errors?: ProviderErrors;
  /** Called with the field key when a control loses focus (live validation). */
  onFieldBlur?: (field: "baseUrl" | "model" | "apiKey") => void;
  /** Collapsed pool slots use a tighter key field note. */
  compactKeyNote?: boolean;
}

/**
 * The provider block shared by step 2 (source) and the sub-agent slots:
 * kind square radios, base URL, model, API key with Show/Hide.
 */
export function ProviderFields(props: ProviderFieldsProps) {
  const { idPrefix, value, onChange, errors } = props;
  return (
    <>
      <ChoiceGroup
        label="Kind"
        name={`${idPrefix}-kind`}
        value={value.kind}
        options={KIND_OPTIONS}
        onChange={(kind) => onChange(withProviderKind(value, kind))}
      />
      <TextField
        id={`${idPrefix}-baseUrl`}
        label="Base URL"
        required
        mono
        value={value.baseUrl}
        placeholder={DEFAULT_BASE_URL[value.kind]}
        onChange={(baseUrl) => onChange({ ...value, baseUrl })}
        onBlur={() => props.onFieldBlur?.("baseUrl")}
        error={errors?.baseUrl}
        note={`default for ${value.kind}: ${DEFAULT_BASE_URL[value.kind]}`}
      />
      <TextField
        id={`${idPrefix}-model`}
        label="Model"
        required
        mono
        value={value.model}
        placeholder={value.kind === "openai" ? "gpt-4.1" : value.kind === "anthropic" ? "claude-sonnet-4" : "gemini-2.5-pro"}
        onChange={(model) => onChange({ ...value, model })}
        onBlur={() => props.onFieldBlur?.("model")}
        error={errors?.model}
      />
      <ApiKeyField
        id={`${idPrefix}-apiKey`}
        label="API key"
        required
        value={value.apiKey}
        placeholder={props.compactKeyNote ? undefined : "sk-…"}
        onChange={(apiKey) => onChange({ ...value, apiKey })}
        onBlur={() => props.onFieldBlur?.("apiKey")}
        error={errors?.apiKey}
        note={props.compactKeyNote ? undefined : "stored with 0600 permissions on disk"}
      />
    </>
  );
}
