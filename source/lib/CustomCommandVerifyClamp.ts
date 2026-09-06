import { type CustomCommandResult, CustomCommandStatus } from "@minecraft/server";

/**
 * Validates that a custom command numeric value is within an inclusive range.
 *
 * @remarks
 * If the value is strictly below `min` or above `max`, a standardized custom command result failure object is returned.
 * If the value is valid, it returns `undefined`.
 *
 * @param value The value to check.
 * @param min The minimum range of the check.
 * @param max The maximum range of the check.
 *
 * @returns A {@link CustomCommandResult} failure if out of bounds, or `undefined` if valid.
 */
export function CustomCommandVerifyClamp(value: number, min: number, max: number): CustomCommandResult | undefined {
	if (value < min) {
		return {
			message: `The number you have entered (${value}) is too small, it must be at least ${min}`,
			status: CustomCommandStatus.Failure,
		};
	}
	if (value > max) {
		return {
			message: `The number you have entered (${value}) is too big, it must be at most ${max}`,
			status: CustomCommandStatus.Failure,
		};
	}
	return undefined;
}
