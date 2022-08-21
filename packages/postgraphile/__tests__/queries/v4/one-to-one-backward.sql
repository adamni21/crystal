select
  __person__."person_full_name" as "0",
  "c"."person_first_name"(__person__) as "1",
  __left_arm__."id"::text as "2",
  __person_2."id"::text as "3",
  __person_2."person_full_name" as "4",
  "c"."person_first_name"(__person_2) as "5",
  __left_arm__."person_id"::text as "6",
  __left_arm__."length_in_metres"::text as "7",
  __person_secret__."sekrit" as "8",
  "c"."person_first_name"(__person_3) as "9",
  __person_3."person_full_name" as "10",
  __person_3."id"::text as "11",
  __person_secret__."person_id"::text as "12",
  __person__."id"::text as "13"
from "c"."person" as __person__
left outer join "c"."left_arm" as __left_arm__
on (__person__."id"::"int4" = __left_arm__."person_id")
left outer join "c"."person" as __person_2
on (__left_arm__."person_id"::"int4" = __person_2."id")
left outer join "c"."person_secret" as __person_secret__
on (__person__."id"::"int4" = __person_secret__."person_id")
left outer join "c"."person" as __person_3
on (__person_secret__."person_id"::"int4" = __person_3."id")
order by __person__."id" asc