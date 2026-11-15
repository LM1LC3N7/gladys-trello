# Trello

**Intégration non officielle**, sans lien avec Atlassian (l’éditeur de Trello).
Jamais testée avec un vrai compte Trello : les requêtes et le format des réponses
viennent de la documentation officielle de l’API REST
(developer.atlassian.com/cloud/trello/rest, lue le 2026-11-15). Les réponses 401
et 400 utilisées par les tests sont les vraies réponses de `api.trello.com` ; le
reste est inventé.

Vos cartes Trello dans Gladys : les cartes **en retard** et **bientôt dues** sur le
tableau de bord, des déclencheurs de scène quand une carte arrive à échéance ou
change de liste, et des actions de scène pour **créer** ou **déplacer** une carte.

## Ce qu’il faut

- Un compte Trello (gratuit suffit).
- Une **clé d’API** et un **jeton** : Trello les donne pour un « Power-Up » que vous
  créez vous-même (il ne s’installe sur aucun tableau, il sert seulement à obtenir
  la clé).
- Gladys 5.1.0 ou plus récent.

## Obtenir la clé et le jeton

1. Ouvrez [l’administration des Power-Ups](https://trello.com/power-ups/admin) et
   cliquez sur **Nouveau**. Nom libre (par exemple « Gladys »), choisissez votre
   espace de travail, une adresse e-mail, puis **Créer**.
2. Onglet **Clé d’API** : **Générer une nouvelle clé d’API**. Copiez la **clé
   d’API** (32 caractères). Le « secret » affiché à côté ne sert pas ici.
3. Toujours sur cette page, cliquez sur le lien **Jeton** (« générer manuellement un
   jeton ») à droite de la clé, vérifiez que l’accès demandé est en lecture **et
   écriture**, puis **Autoriser**. Copiez le jeton affiché (il commence en général
   par `ATTA`).

Le jeton donne accès à tous vos tableaux, comme votre compte : gardez-le pour
Gladys seulement. Vous pouvez le révoquer à tout moment dans les paramètres de
votre compte Trello (Applications).

## Configuration

Onglet **Configuration** de l’intégration :

- **Clé d’API du Power-Up** et **Jeton** : collez-les. Ils sont gardés par Gladys
  dans sa base, jamais réaffichés, envoyés seulement à Trello (dans l’en-tête
  `Authorization`, jamais dans une adresse, jamais dans les journaux).
- **Tableaux suivis** : les noms des tableaux comme dans Trello, ou leurs liens,
  séparés par des virgules (10 au plus). Vide : tous vos tableaux ouverts, les 10
  premiers par ordre alphabétique. Un nom qui ne correspond à aucun tableau, ou à
  plusieurs, est signalé dans le statut (utilisez alors le lien du tableau).
- **Intervalle de lecture** : 5 minutes par défaut (2 à 60).
- **« Bientôt dues »** : une carte dont l’échéance arrive dans les 24 h (1 à 168 h)
  est « bientôt due ».
- **Fuseau horaire des dates affichées** : `Europe/Paris` par défaut. Trello donne
  des instants ; ce fuseau sert seulement à écrire les dates du widget et des
  textes de scène. Un nom inconnu de Node est remplacé par le fuseau par défaut,
  et le statut le dit.

Le bouton **Tester la connexion** lit votre compte et affiche vos tableaux ouverts,
les tableaux suivis et le nombre de cartes en retard et bientôt dues.

## Ce qui est lu, et quand

À chaque lecture (toutes les 5 minutes par défaut) :

- votre compte et la liste de vos tableaux ouverts, une fois par heure (c’est aussi
  la vérification des identifiants) ;
- puis chaque tableau suivi : ses listes ouvertes et ses cartes ouvertes (nom,
  liste, échéance, « terminé », étiquettes, lien). Les cartes archivées et celles
  des listes archivées sont ignorées ; au-delà de 1 000 cartes ouvertes, un tableau
  est coupé (le statut le dit).

Un redémarrage de l’intégration attend la fin de l’intervalle commencé (l’heure de
la dernière tentative est gardée dans /data) ; une reconnexion à Gladys ne relance
pas de lecture. Une modification de la configuration (identifiants, tableaux) est
lue tout de suite.

Rythme : une seule requête à la fois, 300 ms au moins entre deux, 30 requêtes par
10 secondes au plus (Trello en permet 100 par jeton). Avec 3 tableaux, cela fait
environ 4 requêtes toutes les 5 minutes.

## Tableau de bord

Widget **Cartes Trello à échéance** : deux tuiles (en retard, bientôt dues) et
jusqu’à 8 cartes, les cartes en retard d’abord, puis par échéance, avec leur
tableau et leur liste ; chaque carte ouvre sa carte Trello. Réglage facultatif :
un seul tableau. Le widget lit la dernière lecture (aucune requête ; au-delà de
3 intervalles, 30 min au moins, il affiche « données Trello périmées » avec l’âge
de la dernière lecture) ; il est
rafraîchi quand ce qu’il montre change.

Une carte « en retard » a une échéance passée et n’est pas marquée terminée dans
Trello (la case de l’échéance), quelle que soit sa liste.

## Déclencheurs de scène

- **Carte Trello à échéance** : une carte d’un tableau suivi atteint son échéance
  et n’est pas marquée terminée. Vérifié chaque minute, sans requête, sur la
  dernière lecture si elle a au plus deux intervalles et une minute (un tableau
  en échec plus longtemps, ou des identifiants refusés, ne déclenchent rien). Une fois par carte et par échéance (une échéance repoussée
  redéclenche à la nouvelle date). Une échéance déjà passée de plus d’un intervalle
  et une minute quand la carte est lue pour la première fois (premier démarrage,
  tableau longtemps non lu, carte créée en retard) ne déclenche rien : jamais
  d’ancien événement. Les échéances annoncées sont gardées dans /data (3 jours), un
  redémarrage ne les renvoie pas.
- **Carte Trello déplacée** : une carte d’un tableau suivi est passée dans une autre
  liste entre deux lectures. La première lecture ne déclenche rien ; les
  déplacements faits par l’action « Déplacer une carte Trello » ne le déclenchent
  pas (pas de boucle de scène) ; dès qu’une lecture montre la carte dans cette
  liste, un vrai déplacement ultérieur vers elle redéclenche. Une lecture de plus
  de 3 intervalles (30 min au moins) n’est pas comparée : les déplacements d’une
  longue panne ne déclenchent rien.

Filtres : le **nom du tableau** et le **nom de la liste**, exactement comme dans
Trello (Gladys compare les textes à l’identique ; vide : tous).

Variables : carte (`name`), tableau, liste, échéance (`due`, ISO 8601 en UTC, et
`due_local`, par exemple `2026-11-15 18:00` dans le fuseau configuré), lien de la
carte, étiquettes (échéance) ou liste de départ (déplacée). Au plus 20 événements
de chaque sorte par lecture ou par minute : les échéances en plus attendent la
minute suivante, les déplacements au-delà de 20 dans une même lecture ne sont pas
envoyés.

## Actions de scène

- **Créer une carte Trello** : tableau (nom ou lien), liste, nom, description
  facultative, échéance dans N minutes (0 ou vide : sans échéance), position en
  haut ou en bas. Sorties : `created`, `result` (`created` ou `unconfirmed`), `id`,
  `url`, `name`, `board`, `list`. La carte n’est jamais envoyée deux fois : si
  Trello ne répond pas, `created` est faux et `result` vaut `unconfirmed` (la carte
  a peut-être été créée : vérifiez avant de relancer) ; le tableau est relu
  5 secondes plus tard.
- **Déplacer une carte Trello** : tableau, carte (son lien, sinon son nom : casse et
  accents ignorés, sinon la seule carte qui le contient), liste d’arrivée, position.
  La carte est cherchée sur une lecture de moins d’une minute (le tableau est relu
  avant sinon). Sorties : `moved`, `result` (`moved`, `already` si elle y était
  déjà, `not_applied` si Trello répond avec la carte restée dans sa liste,
  `unconfirmed` si Trello n’a pas répondu), `name`, `from_list`, `list`, `url`.
  `moved` n’est vrai que si la réponse de Trello montre la carte dans la nouvelle
  liste.
- **Lire les cartes Trello à échéance** : les cartes en retard et bientôt dues
  (ou seulement l’un des deux), d’un tableau ou d’une liste au choix, d’après la
  dernière lecture (aucune requête ; au-delà de 3 intervalles, 30 min au moins,
  l’action échoue en disant que les données sont périmées). Sorties : `count`, `overdue_count`,
  `soon_count`, `list` (une carte par ligne avec tableau, liste et échéance),
  `next_name`, `next_due`.

Quand rien ne peut partir (identifiants refusés, pause demandée par Trello, tableau,
liste ou carte introuvable ou ambigu, trop de requêtes en 10 secondes, délai de la
scène presque écoulé), l’action échoue avec un message qui commence par « Nothing
sent to Trello » et la cause ; la scène continue. Une requête refusée par Trello
(400) échoue avec « Trello refused the request ». Chaque action répond en moins de
25 secondes.

## Identifiants refusés, pauses, pannes

- **Clé ou jeton refusés** : une réponse 401 de Trello sur la lecture du compte qui
  nomme la clé ou le jeton (« invalid key », « invalid token », jeton expiré ou
  révoqué). Plus rien n’est demandé à Trello avec ces identifiants, même après un
  redémarrage, tant qu’ils ne changent pas ou que **Tester la connexion** ne
  réussit pas. Seuls 8 bits d’une empreinte salée sont gardés dans /data pour le
  savoir, jamais la clé ni le jeton.
- Un 401 sur un **tableau** (accès retiré à ce tableau) n’est jamais un refus des
  identifiants : ce tableau est relu plus tard (intervalle doublé à chaque échec,
  1 h au plus) et les autres continuent. S’il répond « invalid token », le compte
  est relu à la lecture suivante pour trancher.
- **Trop de requêtes (429)** : toutes les requêtes s’arrêtent le temps que Trello
  demande (`Retry-After`, sinon 60 s, puis doublé), entre 60 secondes et 6 heures ;
  la pause est gardée dans /data et tient après un redémarrage.
- **Erreur serveur (5xx)** : sur le compte, même pause qu’un 429 ; sur un tableau,
  seul ce tableau est espacé.
- Réponses bornées : 4 Mo pour un tableau, 1 Mo pour le compte, 15 s par requête en
  arrière-plan.
- /data illisible : rien n’est demandé à Trello, nouvel essai toutes les 10 s, le
  fichier n’est pas écrasé. Configuration non lue depuis Gladys : redemandée sans
  fin (10 s, puis doublé jusqu’à 5 min).

## Limites

- Jamais testée avec un vrai compte (voir en haut).
- Pas de déclencheur « carte ajoutée » ni d’action « marquer terminée » dans cette
  version.
- Un déclencheur « carte déplacée » est vu à la lecture suivante (5 minutes par
  défaut), pas en temps réel (Trello propose des webhooks, non utilisés ici).
- 10 tableaux suivis au plus, 1 000 cartes ouvertes lues par tableau.

## Données et confidentialité

Les cartes ne quittent pas Gladys : elles sont gardées en mémoire (la dernière
lecture) ; /data ne contient que l’heure de la dernière lecture, une pause
éventuelle, les identifiants des cartes dont l’échéance a été annoncée, et, après
un refus, 8 bits d’empreinte salée. Rien de Trello n’est livré dans ce dépôt ni dans
l’image Docker.
