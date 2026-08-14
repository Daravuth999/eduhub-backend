/**
 * bookFactoryVoicePicker.test.jsx — additive voice picker (§AMENDMENT 9).
 * Confirms it is a standalone component with its OWN /api/studio/voices
 * fetch, independent of StudioEditor's existing inline voice picker.
 */
import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

jest.mock("../api", () => ({ listVoices: jest.fn() }));
const { listVoices } = require("../api");
const BookFactoryVoicePicker = require("../bookFactory/BookFactoryVoicePicker").default;

test("loads voices independently and defaults to the server default voice", async () => {
  listVoices.mockResolvedValue({ voices: [{ voice_id: "v1", name: "One" }, { voice_id: "v2", name: "Two" }], default_voice_id: "v2" });
  const onChange = jest.fn();
  await act(async () => { render(<BookFactoryVoicePicker value="" onChange={onChange} />); });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("v2"));
});

test("does not override an already-selected value on load", async () => {
  listVoices.mockResolvedValue({ voices: [{ voice_id: "v1", name: "One" }], default_voice_id: "v1" });
  const onChange = jest.fn();
  await act(async () => { render(<BookFactoryVoicePicker value="v1" onChange={onChange} />); });
  await waitFor(() => expect(screen.getByTestId("bf-voice-picker")).not.toBeDisabled());
  expect(onChange).not.toHaveBeenCalled();
});

test("network failure leaves the picker disabled rather than crashing", async () => {
  listVoices.mockRejectedValue(new Error("network"));
  await act(async () => { render(<BookFactoryVoicePicker value="" onChange={jest.fn()} />); });
  await waitFor(() => expect(screen.getByTestId("bf-voice-picker")).toBeDisabled());
});

test("selecting a voice calls onChange with the picked voice_id", async () => {
  listVoices.mockResolvedValue({ voices: [{ voice_id: "v1", name: "One" }, { voice_id: "v2", name: "Two" }] });
  const onChange = jest.fn();
  await act(async () => { render(<BookFactoryVoicePicker value="v1" onChange={onChange} />); });
  await waitFor(() => expect(screen.getByTestId("bf-voice-picker")).not.toBeDisabled());
  fireEvent.change(screen.getByTestId("bf-voice-picker"), { target: { value: "v2" } });
  expect(onChange).toHaveBeenCalledWith("v2");
});
