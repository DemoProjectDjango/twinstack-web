---
title: Contact
description: How to get in touch.
url: /contact.html
---
<section class="bg-zinc-50">
  <div class="mx-auto max-w-5xl px-6 py-16 sm:py-20">
    <h1 class="text-4xl font-bold tracking-tight text-zinc-900">Contact us</h1>
    <p class="mt-4 max-w-2xl text-lg text-zinc-600">We'd love to hear from you. Here's how to reach {{ site.name }}.</p>
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto grid max-w-5xl gap-6 px-6 py-14 sm:grid-cols-2">
    {{# if site.contact.email }}
    <a href="mailto:{{ site.contact.email }}" class="rounded-xl border border-zinc-200 p-6 hover:border-brand">
      <p class="text-sm font-semibold uppercase tracking-wider text-brand">Email</p>
      <p class="mt-2 break-words text-lg text-zinc-900">{{ site.contact.email }}</p>
    </a>
    {{/ if }}
    {{# if site.contact.phone }}
    <a href="tel:{{ site.contact.phone }}" class="rounded-xl border border-zinc-200 p-6 hover:border-brand">
      <p class="text-sm font-semibold uppercase tracking-wider text-brand">Phone</p>
      <p class="mt-2 text-lg text-zinc-900">{{ site.contact.phone }}</p>
    </a>
    {{/ if }}
    {{# if site.contact.address }}
    <div class="rounded-xl border border-zinc-200 p-6">
      <p class="text-sm font-semibold uppercase tracking-wider text-brand">Address</p>
      <p class="mt-2 text-lg text-zinc-900">{{ site.contact.address }}</p>
    </div>
    {{/ if }}
    {{# if site.contact.hours }}
    <div class="rounded-xl border border-zinc-200 p-6">
      <p class="text-sm font-semibold uppercase tracking-wider text-brand">Opening hours</p>
      <p class="mt-2 whitespace-pre-line text-lg text-zinc-900">{{ site.contact.hours }}</p>
    </div>
    {{/ if }}
  </div>
</section>
