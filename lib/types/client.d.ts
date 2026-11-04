/**
 * Browser side of dsh-one.
 *
 * The assistant is a real conversation, not a floating widget. This half
 * contributes exactly two seats and no custom chat surface:
 *
 * 1. `sidebar.panellist` — an entry that sits above the workspace list, in the
 *    same list as the shipped Plugins / Schedules icons. DSH owns the row's
 *    click, and it does one thing: `layout.selectPanel(id)`. The matching
 *    `main` panel therefore follows the click and immediately hands control to
 *    the assistant's real DSH session, whose conversation DSH renders itself.
 * 2. `settings.section` — this plugin's own Settings tab, instead of a row
 *    inside somebody else's General page.
 *
 * Written against the DSH client module closure-factory protocol; React is
 * resolved through the platform module table.
 */
export {};
