-- wv4168 (besluitenpagina nr 116 = 2C16): eindstand per abonnementsweek van abonnement 1 (machinekamer.tankmeting), laatste 70 dagen,
-- plus het aantal werkvoorraadstarts sinds de laatste weekreset. Alleen lezen; voor GET /app/verbruik (vorige week, staafjes per week,
-- vertaling naar agentklussen). eind = de laatste meting vóór de reset (zo verviel 1 - eind).
create or replace function public.mk_app_verbruik_weken()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select jsonb_build_object(
    'weken', coalesce((select jsonb_agg(jsonb_build_object('reset', w.r, 'eind', w.eind, 'hoogste', w.hoogste,
                 'laatste_op', w.laatste_op, 'metingen', w.n) order by w.r)
               from (select t.zeven_dagen_reset r, (array_agg(t.zeven_dagen order by t.gemeten_op desc))[1] eind,
                            max(t.zeven_dagen) hoogste, max(t.gemeten_op) laatste_op, count(*)::int n
                       from machinekamer.tankmeting t
                      where t.gemeten_op > now() - interval '70 days' and t.zeven_dagen is not null and t.zeven_dagen_reset is not null
                      group by t.zeven_dagen_reset) w), '[]'::jsonb),
    'starts_sinds_reset', (select count(*)::int from machinekamer.werkvoorraad v
                            where v.gestart_op >= (select t.zeven_dagen_reset - interval '7 days' from machinekamer.tankmeting t
                                                    where t.zeven_dagen_reset is not null order by t.gemeten_op desc limit 1))
  );
$function$;
revoke all on function public.mk_app_verbruik_weken() from public;
grant execute on function public.mk_app_verbruik_weken() to service_role;
insert into supabase_migrations.schema_migrations(version, name) values ('20261126210000', 'mk_app_verbruik_weken_wv4168') on conflict do nothing;
notify pgrst, 'reload schema';
