---
title: Volunteer
description: Give a few hours and make a real difference. Find a volunteering role that suits you.
url: /volunteer.html
---
<section class="bg-amber-50">
  <div class="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
    <div>
    <p class="text-sm font-semibold uppercase tracking-wider text-brand">Volunteer</p>
    <h1 class="mt-3 text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl">{{ data.copy.volunteerTitle }}</h1>
    <p class="mt-5 max-w-2xl text-lg text-stone-700">{{ data.copy.volunteerText }}</p>
    <a href="{{# if data.volunteer.formUrl }}{{ data.volunteer.formUrl }}{{ else }}/contact.html{{/ if }}" class="mt-8 inline-block rounded-full bg-brand px-6 py-3 font-semibold text-white hover:opacity-90">Sign up to volunteer</a>
    </div>
    <img data-photo="volunteer" src="/assets/img/kit/hearth/volunteer.webp" alt="Volunteers at work together" width="1536" height="1024" class="aspect-[4/3] w-full rounded-3xl object-cover shadow-xl">
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto max-w-6xl px-6 py-20">
    <h2 class="text-3xl font-bold text-stone-900">Roles we need</h2>
    <div class="mt-10 grid gap-6 sm:grid-cols-2">
      {{# each data.volunteer.items }}
      <article {{# if sample }}data-sample{{/ if }} class="rounded-2xl p-7 ring-1 ring-stone-200">
        <p class="text-sm font-semibold text-brand">{{ time }}</p>
        <h3 class="mt-1 text-xl font-semibold text-stone-900">{{ title }}</h3>
        <p class="mt-2 text-stone-600">{{ summary }}</p>
      </article>
      {{/ each }}
    </div>
  </div>
</section>

<section class="bg-stone-50">
  <div class="mx-auto max-w-6xl px-6 py-20">
    <h2 class="text-3xl font-bold text-stone-900">How it works</h2>
    <ol class="mt-10 grid gap-6 md:grid-cols-3">
      <li class="rounded-2xl bg-white p-7 ring-1 ring-stone-200">
        <span class="flex h-10 w-10 items-center justify-center rounded-full bg-brand font-bold text-white">1</span>
        <h3 class="mt-4 font-semibold text-stone-900">Sign up</h3>
        <p class="mt-2 text-stone-600">Tell us a little about yourself and when you're free.</p>
      </li>
      <li class="rounded-2xl bg-white p-7 ring-1 ring-stone-200">
        <span class="flex h-10 w-10 items-center justify-center rounded-full bg-brand font-bold text-white">2</span>
        <h3 class="mt-4 font-semibold text-stone-900">Meet the team</h3>
        <p class="mt-2 text-stone-600">Come to a welcome session and try a shift with a buddy.</p>
      </li>
      <li class="rounded-2xl bg-white p-7 ring-1 ring-stone-200">
        <span class="flex h-10 w-10 items-center justify-center rounded-full bg-brand font-bold text-white">3</span>
        <h3 class="mt-4 font-semibold text-stone-900">Make a difference</h3>
        <p class="mt-2 text-stone-600">Help as often as suits you. Every hour counts.</p>
      </li>
    </ol>
  </div>
</section>
