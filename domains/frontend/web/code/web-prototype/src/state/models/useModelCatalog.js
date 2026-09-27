import { useMemo } from "react";

import { useModelProfilesQuery } from "../../api/queries.js";
import { modelPickerOptions, normalizeModelFilters } from "./modelCatalog.js";

export function useModelCatalog({
  profileId = "",
  capabilities = [],
  context = "",
  selectedRevisionId = "",
  selectedProfileId = "",
  readiness = "",
  selectionKind = "revision",
  enabled = true,
} = {}) {
  const filters = useMemo(
    () => ({
      ...normalizeModelFilters({ capabilities, context, selectedRevisionId, readiness }),
      ...(profileId ? { profileId } : {}),
    }),
    [profileId, capabilities.join("\u0000"), context, selectedRevisionId, readiness],
  );
  const query = useModelProfilesQuery(filters, enabled);
  const profiles = query.data?.data || [];
  const selectedValue = selectionKind === "profile" ? selectedProfileId : selectedRevisionId;
  const options = useMemo(
    () => modelPickerOptions(profiles, {
      requiredCapabilities: filters.capabilities,
      selectionKind,
      selectedValue,
    }),
    [profiles, filters.capabilities.join("\u0000"), selectionKind, selectedValue],
  );
  return { ...query, filters, profiles, options };
}
