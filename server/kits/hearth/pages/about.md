---
title: About
description: Who we are, why we started and the people who keep us going.
url: /about.html
---
<section class="bg-amber-50">
  <div class="mx-auto max-w-4xl px-6 py-20">
    <p class="text-sm font-semibold uppercase tracking-wider text-brand">About us</p>
    <h1 class="mt-3 text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl">{{ data.copy.aboutTitle }}</h1>
    {{# if site.description }}<p class="mt-5 max-w-2xl text-lg text-stone-700">{{ site.description }}</p>{{/ if }}
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-5">
    <div data-sample class="lg:col-span-3">
      <h2 class="text-3xl font-bold text-stone-900">Our story</h2>
      <p class="mt-5 text-lg leading-relaxed text-stone-700">{{ data.copy.story1 }}</p>
      <p class="mt-4 text-lg leading-relaxed text-stone-700">{{ data.copy.story2 }}</p>
    </div>
    <div class="space-y-4 lg:col-span-2">
      <img data-photo="about" src="/assets/img/kit/hearth/about.webp" alt="Our team and volunteers" width="1536" height="1024" loading="lazy" class="aspect-[3/2] w-full rounded-2xl object-cover">
      <div class="rounded-2xl bg-stone-50 p-6">
        <h3 class="font-semibold text-stone-900">Dignity first</h3>
        <p class="mt-1 text-stone-600">Help is given with respect and without judgement.</p>
      </div>
      <div class="rounded-2xl bg-stone-50 p-6">
        <h3 class="font-semibold text-stone-900">Local and open</h3>
        <p class="mt-1 text-stone-600">We share where every donation goes.</p>
      </div>
      <div class="rounded-2xl bg-stone-50 p-6">
        <h3 class="font-semibold text-stone-900">Everyone welcome</h3>
        <p class="mt-1 text-stone-600">To ask for help, or to give it.</p>
      </div>
    </div>
  </div>
</section>

<section class="bg-stone-50">
  <div class="mx-auto max-w-6xl px-6 py-20">
    <h2 class="text-3xl font-bold text-stone-900">The team</h2>
    <div class="mt-10 grid grid-cols-2 gap-6 md:grid-cols-4">
      {{# each data.team.items }}
      <div {{# if sample }}data-sample{{/ if }} class="rounded-2xl bg-white p-6 text-center ring-1 ring-stone-200">
        <span class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-lg font-bold text-stone-900">{{ initials }}</span>
        <p class="mt-4 font-semibold text-stone-900">{{ name }}</p>
        <p class="text-sm text-stone-600">{{ role }}</p>
      </div>
      {{/ each }}
    </div>
  </div>
</section>
