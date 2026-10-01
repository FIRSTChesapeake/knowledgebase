---
title: Payments and Refunds
---
# Contents
[[#How Refunds Work]]
[[#Full and Partial Refunds]]
[[#The Card Payments Table]]
[[#What Coaches See]]
[[#The Third Qualifier Seat]]
[[#What to Check After a Refund]]

This guide is for admins of the FTC registration site. It covers how card refunds show up in the site, where to find them, and what a refund does to a team's registration.

# How Refunds Work

Refunds are **issued in Stripe**, not in the registration site. The site has no refund button. Once Stripe has processed a refund of a card payment, the site records it by itself: the payment shows the refund's date and amount, and a full refund also marks the team unpaid again.

This applies to **card payments** only, of all three kinds: season registration, the District Championship fee, and the optional third qualifier. Purchase orders are tracked separately under **Reports → 📄 Purchase Orders** and don't appear in the refund views.

The site tells teams that fees are non-refundable ("Registration fees are non-refundable.", "Championship fees are non-refundable."), so a refund is an exception that an admin decides on and makes in Stripe.

# Full and Partial Refunds

| | Full refund | Partial refund |
|---|---|---|
| Payment's **Status** | `refunded` | stays `paid` |
| Refund label | "Refunded $*amount* on *date*" | "Partially refunded $*amount* on *date*" |
| Team's paid status | Cleared: the team shows as **unpaid** for that fee again | Unchanged: the team stays paid |
| Third qualifier seat | Released (see [[#The Third Qualifier Seat]]) | Kept |

What to watch for:

- **A partial refund changes nothing but the label.** The team keeps its paid status and its place. If a partial refund is meant to withdraw a team, make that change yourself.
- **The amount is the running total.** After a second partial refund of the same payment, the label shows the total refunded so far, with the latest date. If the rest is refunded later, the payment becomes a full refund.
- **A full refund clears only what that payment paid for.** A team that is also covered by another paid payment for the same fee stays paid, and the skipped team is noted in the audit log (see [[#What to Check After a Refund]]).
- **A full refund always counts, even if its amount can't be read.** The team is still marked unpaid and the label shows the date without an amount.
- **Older refunds have less detail.** A refund recorded before the site kept refund details reads just "Refunded", with no amount or date.

# The Card Payments Table

Open the admin dashboard's **📋 Reports** tab. The **💳 Payments** sub-tab opens first; **💳 Card Payments** is the section below **⚠️ Unpaid Teams**. It lists the selected season's card payments, newest first.

Next to the heading, a gray badge counts the payments ("*n* payments") and a red badge counts those with a refund ("*n* with refunds"). The red badge shows only when there is at least one.

The table starts collapsed. Click **▸ All Card Payments (*n*)** to open it:

| Column | Shows |
|---|---|
| **Paid** | The date the payment was made, or "—" if it never completed |
| **Coach** | The paying coach's name, with their email under it |
| **Teams** | The team numbers the payment covers |
| **Type** | `registration`, `championship` or `third_qualifier` |
| **Amount** | The amount originally charged. A refund does **not** reduce it |
| **Status** | A badge: `paid` (green), `refunded` (red), `pending` (yellow) or `expired` (gray) |
| **Refund** | The refund label in red, or blank when nothing was refunded |

`pending` is a checkout the coach started and hasn't finished; `expired` is one they never finished.

The table is for reading only: it has no filters, sorting or export, and nothing in it can be edited. (The **⬇ Download CSV** button on this page belongs to **Unpaid Teams**.) To find one team's payment, open the table and use your browser's find.

You may also see "Loading…", "No card payments this season.", or, if the list can't be fetched, "Failed to load payments." or "Network error. Please try again." — reload the page to try again.

# What Coaches See

Coaches see refunds on their own payments, in the same wording as the admin table:

- **Registration.** On the registration card, **View payment history** lists each payment with its date, teams, amount and status badge, and the refund label in red under the row. The list shows only the payments made by the coach who is signed in, so a co-coach won't see a payment someone else made. Here the badge is green for `paid` and yellow for every other status, `refunded` included.
- **District Championship.** The refund label shows in red on the championship card. After a full refund the card goes back to showing the fee as unpaid (or that the payment window isn't open), with the "Refunded…" line; after a partial refund it still shows the team as paid, with the "Partially refunded…" line.
- **Third qualifier.** The third qualifier card shows no refund information. After a full refund the team simply shows as not having paid for a third qualifier.

If a coach asks why their team shows as unpaid, check the Card Payments table for a full refund first.

# The Third Qualifier Seat

A team that pays for the optional third qualifier picks its own seat at a qualifier. Refunds take that seat into account:

- A **full refund** of a third-qualifier payment gives the seat back: the team's self-selected third qualifier is removed and the seat is open to other teams again.
- A seat an **admin placed** the team in is kept. Remove it yourself if the team is withdrawing.
- A **partial refund** keeps the seat.

Refunds of registration or championship payments don't change any lottery placement or qualifier assignment. Nothing is filled automatically when a seat opens; it's simply available again.

# What to Check After a Refund

1. In Stripe, confirm the refund went through.
2. In **Reports → 💳 Payments → 💳 Card Payments**, find the payment and check its **Status** and **Refund** columns match what you did. It can take a moment to arrive; reload the page.
3. For a full refund, check the team now shows as unpaid for that fee, under **⚠️ Unpaid Teams** for a registration refund.
4. For a third-qualifier refund, check the team's third qualifier seat is gone, or remove it if an admin placed it.
5. For a partial refund, make any change to the team's registration yourself; the site makes none.

If the refund doesn't appear:

- **Check it was a card payment made through the site.** A refund that doesn't match any payment in the site is not recorded anywhere, and nothing warns you. The same goes for a partial refund whose amount can't be read.
- **Check Reports → 🔍 Audit.** When the site records a refund or payment but can't finish the job cleanly, it leaves an entry from `system:stripe-webhook` with the action `stripe-payment-needs-attention` and the details. One example is a team left paid after a refund because another payment covers it. Correct the team's record by hand from the details given.
