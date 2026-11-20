import { afterEach, expect, it } from "vitest";
import { getComputeEngineSelection } from "./computeEngine";
const original = window.location.href;
afterEach(() => { localStorage.clear(); history.replaceState(null, "", original); });
it("tracks valid URL and storage selections without marking the default explicit", () => {
  localStorage.clear(); history.replaceState(null, "", "/GeotRadarSim/");
  expect(getComputeEngineSelection()).toEqual({ engine: "wasm", explicit: false });
  localStorage.setItem("geotradarsim.engine", "ts");
  expect(getComputeEngineSelection()).toEqual({ engine: "ts", explicit: true });
  history.replaceState(null, "", "/GeotRadarSim/?engine=wasm");
  expect(getComputeEngineSelection()).toEqual({ engine: "wasm", explicit: true });
});
