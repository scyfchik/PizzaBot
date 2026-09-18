import { getCategory } from '../../systems/tickets/categories.js';
import { categoryModal } from '../../systems/tickets/components.js';
import { UserError } from '../../core/errors.js';

export const domain = 'ticket';
export const actions = ['open'];

/**
 * Panel select menu -> category modal.
 *
 * `showModal` must be the *first* response to an interaction, so nothing here
 * may defer, reply, or await anything slow first. This previously loaded the
 * guild config to check whether the category was disabled, which meant a cold
 * database read sat between the click and the modal — past three seconds,
 * Discord gives up and the user sees "This application did not respond".
 *
 * The category lookup below is a Map read. Everything needing the database
 * happens after submit, in ticketSubmit.js, which defers first.
 */
export async function execute(interaction) {
  const categoryKey = interaction.values[0];
  const category = getCategory(categoryKey);

  if (!category) throw new UserError('That category is no longer available.');

  await interaction.showModal(categoryModal(category));
}
