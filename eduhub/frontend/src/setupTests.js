// Jest setup — extends expect with @testing-library/jest-dom matchers.
import "@testing-library/jest-dom";

// jsdom (jest test env) does not expose structuredClone; the browser runtime
// does. Provide a test-only polyfill so component rendering matches runtime.
if (typeof global.structuredClone !== "function") {
  global.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
}

// jsdom does not implement ResizeObserver. `cmdk` (Studio OS command
// palette, StudioCommandPalette.jsx) uses it internally to measure list
// height, so any test that mounts a real cmdk Command throws
// "ResizeObserver is not defined" without this. No-op is sufficient since
// jsdom never actually resizes anything for a callback to react to.
if (typeof global.ResizeObserver !== "function") {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not implement Element.scrollIntoView either. `cmdk` calls it
// to keep the auto-selected first item in view as the list filters.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
