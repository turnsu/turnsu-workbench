import { useMemo } from "react";

import { useModelProfilesQuery } from "../../api/queries.js";
import { modelPickerOptions, normalizeModelFilters } from "./modelCatalog.js";

export function useModelCatalog({
  capabilities = [],
  context = "",
  selectedRevisionId = "",
  readiness = "",
  selectionKind = "revision",
  enabled = true,
} = {}) {
  const filters = useMemo(
    () => normalizeModelFilters({ capabilities, context, selectedRevisionId, readiness }),
    [capabilities.join("\u0000"), context, selectedRevisionId, readiness],
  );
  const query = useModelProfilesQuery(filters, enabled);
  const profiles = query.data?.data || [];
  const options = useMemo(
    () => modelPickerOptions(profiles, {
      requiredCapabilities: filters.capabilities,
      selectionKind,
      selectedValue: selectedRevisionId,
    }),
    [profiles, filters.capabilities.join("\u0000"), selectionKind, selectedRevisionId],
  );
  return { ...query, filters, profiles, options };
}
