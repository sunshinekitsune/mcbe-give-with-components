import {
	CommandPermissionLevel,
	CustomCommandParamType,
	CustomCommandStatus,
	EntityComponentTypes,
	ItemStack,
	type ItemType,
	type Player,
	system,
	type Vector3,
} from "@minecraft/server";
import { MinecraftBlockTypes } from "@minecraft/vanilla-data";
import { CustomCommandVerifyClamp } from "../lib/CustomCommandVerifyClamp";
import { isEntityValid } from "../lib/entityState";

/**
 * Spawns an item at a player's location, safely.
 *
 * @remarks
 * This function spawns items at a `target`'s location, primarily for {@link givePlayerItem} when the `target`'s
 * inventory becomes full. It does this by first checking if the current chunk is loaded. If it is, spawn the item at
 * the `target` but within vertical world bounds then teleport it to them. If the chunk is not loaded, then wait
 * `maxTicks` for it to load. If the chunk does load within that time the item spawns as expected, otherwise it gives
 * up and the item is ""temporally"" lost.
 *
 * @param target The player to spawn the item at.
 * @param itemStack The item to spawn at the player.
 * @param maxTicks The maximum time in ticks to wait. Default is 100 (5 seconds).
 * @param chunkLoaded Is the chunk at the `target`'s location already loaded? This will be automatically determined if not provided, but it may
 * be a performance speedup to cache this information if this function is called many times in the same tick.
 *
 * @returns A boolean in a promise for if the item spawn was successful or not.
 */
async function spawnItemAtPlayer(
	target: Player,
	itemStack: ItemStack,
	maxTicks = 100,
	chunkLoaded: boolean = target.dimension.isChunkLoaded(target.location),
): Promise<boolean> {
	if (!chunkLoaded) {
		// Wait for the chunk to load to load.
		for (let i = 0; i < maxTicks; i++) {
			// biome-ignore lint/performance/noAwaitInLoops: Failsafe requires waiting for chunks.
			await system.waitTicks(1);

			// Make sure the player hasn't died or left.
			// Hopefully, it's not a thing for a player to die and spawn in the same tick.
			if (!isEntityValid(target)) {
				return false;
			}

			// If the chunk is loaded, break out and move on.
			if (target.dimension.isChunkLoaded(target.location)) {
				chunkLoaded = true;
				break;
			}
		}

		// If it doesn't load by then, we give up.
		if (!chunkLoaded) {
			return false;
		}
	}

	// Minecraft throws an error if we try to spawn an entity outside of world bounds.
	const location: Vector3 = {
		x: target.location.x,
		y: target.dimension.heightRange.min,
		z: target.location.z,
	};
	const itemEntity = target.dimension.spawnItem(itemStack, location);

	// But we can teleport an entity out of bounds!
	location.y = target.location.y;
	itemEntity.teleport(location);
	return true;
}

/**
 * Gives a player items in a very similar way to Minecraft's /give command.
 *
 * @remarks
 * This function will work its way through 2 different ways of providing the `target` the amount of items to give. It
 * will and the first work through the total `amount` by adding directly to the container. If the `target`'s inventory
 * becomes full total amount hasn't been given, the items will be spawned on the ground at the `target`. If the
 * `target` is in unloaded chunks for too long, the items will be lost. More info at {@link spawnItemAtPlayer}.
 *
 * This function can't be called in restricted-execution mode.
 *
 * @param target The player to give the item.
 * @param itemStack The item stack to give.
 * @param amount How much of that item to give, notably, above 64.
 */
async function givePlayerItem(target: Player, itemStack: ItemStack, amount: number): Promise<void> {
	// Make a copy of the item stack to not modify the source.
	// Not neccessary for the context of this function in /component:give but still a good practice.
	itemStack = itemStack.clone();

	// If they are invalid, somehow, skip them.
	if (!isEntityValid(target)) {
		return;
	}

	const inventory = target.getComponent(EntityComponentTypes.Inventory);
	if (inventory === undefined) {
		return;
	}

	let remaining = amount;
	let isInventoryFull = false;

	let chunkLoaded: boolean = target.dimension.isChunkLoaded(target.location);
	let tick: number = system.currentTick;

	while (remaining > 0) {
		// Determine the amount to give for this item stack by finding the lowest between the total remaining items and
		// the maximum the type of item can be, then lower remaining by that amount.
		remaining -= itemStack.amount = Math.min(remaining, itemStack.maxAmount);

		// container.addItem usually returns undefined but will return an item stack if the inventory is full, with an
		// amount equal to how much was left over.
		const spillStack = isInventoryFull ? itemStack : inventory.container.addItem(itemStack);
		if (spillStack !== undefined) {
			isInventoryFull = true;

			if (system.currentTick !== tick) {
				tick = system.currentTick;
				chunkLoaded = target.dimension.isChunkLoaded(target.location);
			}
			// biome-ignore lint/performance/noAwaitInLoops: Required to know if we chose to give up.
			const success = await spawnItemAtPlayer(target, spillStack, 100, chunkLoaded);
			if (!success) {
				return;
			}
		}
	}
}

/**
 * Resolves an {@link ItemStack} with a data value.
 *
 * @remarks
 * Minecraft's `ItemStack` class nor `ItemType` interface provide a way to set data values. This means for cases such
 * like beds, tipped arrows, and potions, we have fall back to traditional commands to get them. This is done by using
 * some player's first inventory slot as a staging workspace to get the item.
 *
 * This restores the item after within the same tick, so no items are lost by the player used for staging.
 *
 * Sometimes can be `undefined` if a peculiar itemType is provided, such as `minecraft:air`.
 *
 * This function can't be called in restricted-execution mode.
 *
 * @param targets The list of players to potentially use as a item staging workspace.
 * @param itemType The item's type.
 * @param data The desired data value of the item.
 *
 * @returns Returns an `ItemStack` with the desired data value or `undefined` if the item type is dubious.
 */
function resolveItemStack(targets: Player[], itemType: ItemType, data: number): ItemStack | undefined {
	// If there is no data value, we can get it directly.
	if (data === 0) {
		try {
			// If the item is air, just return undefined. ItemStack will throw if you try to make an "air" item stack.
			return itemType.id === MinecraftBlockTypes.Air ? undefined : new ItemStack(itemType.id, 1);
		} catch {
			// Good practice, though I think unreachable from /component:give command.
			return undefined;
		}
	}

	for (const target of targets) {
		// We use the first valid player we see to build the item template.
		if (!isEntityValid(target)) {
			continue;
		}

		const inventory = target.getComponent(EntityComponentTypes.Inventory);
		if (inventory === undefined) {
			continue;
		}

		// 1. Save the item in slot 0.
		const originalStack = inventory.container.getItem(0);

		// safeguard set the slot to air in case the command fails. I haven't been able to identify a case where it has,
		// but minecraft gives me trust issues.
		inventory.container.setItem(0);

		// 2. Replace the item in the same slot using a command to use data values.
		target.runCommand(`replaceitem entity @s slot.hotbar 0 ${itemType.id} 1 ${data}`);

		// 3. Get the item
		const resolvedStack = inventory.container.getItem(0);

		// 4. Restore the original item.
		inventory.container.setItem(0, originalStack);

		// 5. Exit early
		return resolvedStack;
	}

	// If no player is valid to build the item template that is fine, none of them need it anyways.
	// That assumption is only true if the context of this function's call remains in the /component:give command.
	return undefined;
}

system.beforeEvents.startup.subscribe((event) => {
	event.customCommandRegistry.registerCommand(
		{
			cheatsRequired: true,
			description: "Gives an item with components to a player.",
			mandatoryParameters: [
				{
					name: "target",
					type: CustomCommandParamType.PlayerSelector,
				},
				{
					name: "itemName",
					type: CustomCommandParamType.ItemType,
				},
				{
					name: "amount",
					type: CustomCommandParamType.Integer,
				},
				{
					name: "data",
					type: CustomCommandParamType.Integer,
				},
				{
					name: "components",
					type: CustomCommandParamType.String,
				},
			],
			name: "component:give",
			permissionLevel: CommandPermissionLevel.GameDirectors,
		},
		(_origin, targets: Player[], itemType: ItemType, amount: number, data: number, _components: string) => {
			if (targets.length === 0) {
				return {
					message: "No targets matched selector",
					status: CustomCommandStatus.Failure,
				};
			}

			// Doesn't specify what parameter is the issue. This mimics vanilla behavior.
			let validation = CustomCommandVerifyClamp(amount, 1, 32767);
			if (validation !== undefined) {
				return validation;
			}

			validation = CustomCommandVerifyClamp(data, 0, 32767);
			if (validation !== undefined) {
				return validation;
			}

			// biome-ignore lint/nursery/noMisusedPromises: system.run does not inspect the returned promise.
			system.run(async () => {
				// Get the item stack with a specific data value. This is needed for beds, potions, tipped arrows, etc.
				const resolvedStack = resolveItemStack(targets, itemType, data);

				// May be undefined for things like air.
				if (resolvedStack === undefined) {
					return;
				}

				for (const target of targets) {
					givePlayerItem(target, resolvedStack, amount);
				}
			});

			// Always say item was given to all players. This mimics vanilla behavior.
			return {
				message: `Gave ${itemType.id} * ${amount} to ${targets.map((t) => t.name).join(", ")}`,
				status: CustomCommandStatus.Success,
			};
		},
	);
});
