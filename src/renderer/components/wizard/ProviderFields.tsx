import { useMemo } from "react";
import type { CatalogMeta, CatalogProviderMeta, ProviderConfig, ProviderKind } from "../../../shared/types";
import { CUSTOM_BASE_URL, formatCtx, toCustomEndpoint, withCatalogProvider, withProviderKind } from "./draft";
import { ApiKeyField, ChoiceGroup, TextField, type ChoiceOption } from "./fields";
import { ProviderPicker } from "./ProviderPicker";

const KIND_OPTIONS: readonly ChoiceOption<ProviderKind>[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
];

const KIND_PLACEHOLDER: Record<ProviderKind, string> = {
  openai: "gpt-4.1",
  anthropic: "claude-sonnet-4",
  google: "gemini-2.5-pro",
};

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
  /** The models.dev catalog from bootstrap; null while it is still loading. */
  catalog: CatalogMeta | null;
  errors?: ProviderErrors;
  /** Called with the field key when a control loses focus (live validation). */
  onFieldBlur?: (field: "baseUrl" | "model" | "apiKey") => void;
  /** Collapsed pool slots use a tighter key field note. */
  compactKeyNote?: boolean;
}

/**
 * The provider block shared by step 2 (source) and the sub-agent slots.
 * Catalog path: searchable picker derives providerId/kind/endpoint; the
 * model field gets datalist suggestions and a context note. Custom path
 * (escape hatch): the old kind radios + free base URL.
 */
export function ProviderFields(props: ProviderFieldsProps) {
  const { idPrefix, value, onChange, errors, catalog } = props;

  const entry: CatalogProviderMeta | null =
    value.providerId && catalog ? catalog.providers.find((p) => p.id === value.providerId) ?? null : null;

  const customMode = !entry;

  // Model suggestions: tool-call capable first, hard cap for the datalist.
  const modelList = useMemo(() => {
    if (!entry) return [];
    return [...entry.models]
      .sort((a, b) => Number(b.toolCall ?? false) - Number(a.toolCall ?? false))
      .slice(0, 200);
  }, [entry]);

  const modelNote = useMemo(() => {
    if (!entry) return undefined;
    const typed = value.model.trim().toLowerCase();
    if (!typed) return undefined;
    const meta = entry.models.find((m) => m.id.toLowerCase() === typed || m.name.toLowerCase() === typed);
    if (!meta) return undefined;
    const ctx = formatCtx(meta.context);
    return [ctx ? `${ctx} ctx` : null, meta.toolCall ? "tool calls" : null].filter(Boolean).join(" · ") || undefined;
  }, [entry, value.model]);

  const onDefaultUrl = entry !== null && value.baseUrl.trim() === entry.api;

  return (
    <>
      {catalog === null ? (
        <p className="field-note">provider catalog is loading — you can configure a custom endpoint meanwhile</p>
      ) : value.providerId && !entry ? (
        <p className="field-note">
          saved provider “{value.providerId}” is not in this catalog — kept as a custom endpoint
        </p>
      ) : null}

      {catalog !== null ? (
        <ProviderPicker
          idPrefix={idPrefix}
          catalog={catalog}
          selected={entry}
          onPick={(picked) => onChange(withCatalogProvider(value, picked))}
          onClear={() => onChange(toCustomEndpoint(value))}
        />
      ) : null}

      {customMode ? (
        <>
          <ChoiceGroup
            label={value.providerId ? "Protocol (custom endpoint)" : "Or a custom endpoint"}
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
            placeholder={CUSTOM_BASE_URL[value.kind]}
            onChange={(baseUrl) => onChange({ ...value, baseUrl })}
            onBlur={() => props.onFieldBlur?.("baseUrl")}
            error={errors?.baseUrl}
            note={`fallback for ${value.kind}: ${CUSTOM_BASE_URL[value.kind]}`}
          />
        </>
      ) : (
        <TextField
          id={`${idPrefix}-baseUrl`}
          label="Base URL"
          required
          mono
          value={value.baseUrl}
          placeholder={entry?.api}
          onChange={(baseUrl) => onChange({ ...value, baseUrl })}
          onBlur={() => props.onFieldBlur?.("baseUrl")}
          error={errors?.baseUrl}
          note={onDefaultUrl ? `default for ${entry?.name} — editable` : undefined}
        />
      )}

      <TextField
        id={`${idPrefix}-model`}
        label="Model"
        required
        mono
        value={value.model}
        list={entry ? `${idPrefix}-models` : undefined}
        placeholder={entry ? "pick a model, or type one" : KIND_PLACEHOLDER[value.kind]}
        onChange={(model) => onChange({ ...value, model })}
        onBlur={() => props.onFieldBlur?.("model")}
        error={errors?.model}
        note={modelNote}
      />
      {entry ? (
        <datalist id={`${idPrefix}-models`}>
          {modelList.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
      ) : null}

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
