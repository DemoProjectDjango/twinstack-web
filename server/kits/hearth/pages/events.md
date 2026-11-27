---
title: Events
description: Food drives, community evenings and volunteer welcomes. Everyone's welcome.
url: /events.html
---
<section class="bg-amber-50">
  <div class="mx-auto max-w-4xl px-6 py-20">
    <p class="text-sm font-semibold uppercase tracking-wider text-brand">Events</p>
    <h1 class="mt-3 text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl">Come and join us</h1>
    <p class="mt-5 max-w-2xl text-lg text-stone-700">Bring a friend, bring a donation, or just come and say hello.</p>
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto max-w-4xl space-y-5 px-6 py-16">
    {{# each data.events.items }}
    <article {{# if sample }}data-sample{{/ if }} class="flex flex-col gap-5 rounded-2xl p-6 ring-1 ring-stone-200 sm:flex-row sm:items-center">
      <div class="w-20 shrink-0 rounded-2xl bg-brand py-3 text-center text-white">
        <p class="text-2xl font-bold">{{ day }}</p>
        <p class="text-xs font-semibold uppercase text-white/85">{{ month }}</p>
      </div>
      <div>
        <h2 class="text-xl font-semibold text-stone-900">{{ title }}</h2>
        <p class="mt-1 text-sm font-medium text-stone-500">{{ place }} · {{ time }}</p>
        <p class="mt-2 text-stone-600">{{ summary }}</p>
      </div>
    </article>
    {{/ each }}
  </div>
</section>

<section class="bg-stone-50">
  <div class="mx-auto max-w-4xl px-6 py-14 text-center">
    <h2 class="text-2xl font-bold text-stone-900">Want to run an event for us?</h2>
    <p class="mt-2 text-stone-600">We'd love to help you plan it.</p>
    <a href="/contact.html" class="mt-6 inline-block rounded-full bg-stone-900 px-6 py-3 font-semibold text-white hover:bg-stone-700">Get in touch</a>
  </div>
</section>
