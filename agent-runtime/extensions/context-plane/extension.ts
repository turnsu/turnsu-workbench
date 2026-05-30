export default function contextPlaneExtension(pi: any) {
  // Internal marker extension. The executable Context Plane implementation lives in
  // agent-runtime/control-plane/context-plane.mjs so it can run before tool calling.
  // No public tools are registered here; the frontend only sees Skill/Extension surface.
  return {
    id: "context-plane",
    visibility: "internal",
    status: "available",
  };
}

