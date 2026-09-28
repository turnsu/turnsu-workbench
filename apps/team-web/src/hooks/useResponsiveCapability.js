import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 720px), (pointer: coarse) and (max-width: 900px)";

export function useResponsiveCapability() {
  const [mobile, setMobile] = useState(() => (
    typeof globalThis.matchMedia === "function"
      ? globalThis.matchMedia(MOBILE_QUERY).matches
      : false
  ));

  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") return undefined;
    const query = globalThis.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return {
    mobile,
    skillPackageImport: !mobile,
  };
}
