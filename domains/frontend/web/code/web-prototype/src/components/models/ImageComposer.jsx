import { ImagePlus } from "lucide-react";

import { Button, TextArea, TextInput } from "../../design-system/index.jsx";

export function ImageComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  busy = false,
  parameterSupport = null,
  labels = {},
  testId = "loopops.image-composer",
}) {
  const ready = Boolean(String(value?.prompt || "").trim()) && !disabled && !busy;
  const update = (field, next) => onChange?.({ ...value, [field]: next });
  const imageSupport = parameterSupport?.kind === "image_generation" ? parameterSupport : null;
  const aspectRatios = imageSupport?.aspectRatios?.length
    ? imageSupport.aspectRatios
    : ["16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"];
  const outputFormats = imageSupport?.outputFormats?.length
    ? imageSupport.outputFormats
    : ["png", "jpeg", "webp"];
  return (
    <form
      className="modelComposer imageModelComposer"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit?.();
      }}
      aria-busy={busy ? "true" : undefined}
      data-testid={testId}
    >
      <TextArea
        label={labels.prompt || "Image prompt"}
        hiddenLabel={false}
        value={value?.prompt || ""}
        onChange={(next) => update("prompt", next)}
        placeholder={labels.placeholder || "Describe the image to create"}
        rows={4}
        maxLength={10000}
        width="100%"
        disabled={disabled || busy}
        data-testid={`${testId}.prompt`}
      />
      {imageSupport?.negativePrompt !== false ? (
        <TextInput
          label={labels.negativePrompt || "Avoid (optional)"}
          hiddenLabel={false}
          value={value?.negativePrompt || ""}
          onChange={(next) => update("negativePrompt", next)}
          maxLength={10000}
          disabled={disabled || busy}
          width="100%"
          data-testid={`${testId}.negative-prompt`}
        />
      ) : null}
      <div className="imageComposerFields">
        <label>
          <span>{labels.aspectRatio || "Aspect ratio"}</span>
          <select value={value?.aspectRatio || "1:1"} onChange={(event) => update("aspectRatio", event.target.value)} disabled={disabled || busy}>
            {aspectRatios.map((ratio) => <option value={ratio} key={ratio}>{ratio}</option>)}
          </select>
        </label>
        <label>
          <span>{labels.outputFormat || "Format"}</span>
          <select value={value?.outputFormat || "png"} onChange={(event) => update("outputFormat", event.target.value)} disabled={disabled || busy}>
            {outputFormats.map((format) => <option value={format} key={format}>{format.toUpperCase()}</option>)}
          </select>
        </label>
        {imageSupport?.seed !== false ? (
          <label>
            <span>{labels.seed || "Seed (optional)"}</span>
            <input
              type="number"
              min="0"
              max="4294967294"
              step="1"
              value={value?.seed ?? ""}
              onChange={(event) => update("seed", event.target.value)}
              disabled={disabled || busy}
              inputMode="numeric"
              data-testid={`${testId}.seed`}
            />
          </label>
        ) : null}
      </div>
      <div className="modelComposerActions">
        <small>{labels.governedHint || "Images are saved as workspace artifacts."}</small>
        <Button type="submit" variant="primary" icon={<ImagePlus size={15} />} disabled={!ready} data-testid={`${testId}.submit`}>
          {busy ? (labels.busy || "Creating…") : (labels.submit || "Create image")}
        </Button>
      </div>
    </form>
  );
}
